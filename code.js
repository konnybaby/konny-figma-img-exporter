// Konny Figma Image Exporter — Figma plugin (main thread)
// 캔버스에서 고른 레이어, 또는 고른 프레임 안에서 이름이 패턴에 맞는 레이어를 일괄 내보내기.

// 누구나 알아볼 수 있는 기본값 — 이름에 'img' 가 들어간 레이어를 찾는다.
// 정규식이라 마크업 파트의 '^KO[A-Za-z0-9]{3}_img_' 같은 규칙도 그대로 쓸 수 있다.
var DEFAULT_PATTERN = 'img';

var EXT = { PNG: 'png', JPG: 'jpg', WEBP: 'webp', SVG: 'svg', PDF: 'pdf' };

// Figma 는 WebP 를 내보내지 못한다. PNG 로 받아 UI 에서 다시 인코딩한다.
function figmaFormat(fmt) {
  return fmt === 'WEBP' ? 'PNG' : fmt;
}

var lastMatches = [];

// UI 설정(접힘 상태·창 크기·포맷 등)은 clientStorage 에 저장한다.
// 플러그인 UI iframe 은 localStorage 를 쓸 수 없어, 전에는 창을 열 때마다 초기화됐다.
var PREFS_KEY = 'konnyImageExporter_prefs';
var DEFAULT_SIZE = { w: 360, h: 640 };
var prefs = null;      // clientStorage 에서 읽은 UI 설정 (없으면 null)
var uiReady = false;   // showUI 전에는 UI 로 메시지를 보내지 않는다

// 저장된 크기로 창을 연다. 축소 상태로 닫았으면 축소 크기로 연다.
// 축소 크기(mini)는 축소 상태에서 직접 드래그한 적이 있을 때만 저장되므로,
// 없으면 UI 의 miniSize() 와 같은 방식으로 확대 크기에서 계산한다.
function initialSize(p) {
  var size = p && p.size, full = size && size.full;
  var s = p && p.collapsed
    ? (size && size.mini) || (full && { w: full.w, h: Math.max(124, Math.round(full.h / 5)) }) || { w: 360, h: 128 }
    : full;
  if (s && s.w > 0 && s.h > 0) return { w: Math.max(240, Math.round(s.w)), h: Math.max(96, Math.round(s.h)) };
  return DEFAULT_SIZE;
}

// ---------------------------------------------------------- selection state
// 캔버스 선택은 두 가지로 쓰인다. 사용자가 고른 '범위' 와, 무엇을 내보낼지 레이어 패널에
// 보여 주는 '대상' 이다. 이름 패턴 모드에서 찾은 레이어를 선택해 보여 주면 선택이 바뀌므로,
//  - 사용자가 직접 고른 범위는 userRoots 에 따로 기억하고
//  - 플러그인이 바꾼 선택은 selectionchange 에서 무시한다.
// 그래야 패턴을 고쳐 입력해도 처음 고른 프레임 안에서 다시 찾는다.
var userRoots = figma.currentPage.selection.slice();
var programmaticKey = null;   // 플러그인이 마지막으로 만든 선택 (id 정렬 문자열)

function selKey(nodes) {
  return nodes.map(function (n) { return n.id; }).sort().join(',');
}

function liveRoots() {
  return userRoots.filter(function (n) { return !n.removed; });
}

// 선택을 바꾸되, 그로 인한 selectionchange 는 사용자 동작으로 보지 않는다.
function selectQuietly(nodes) {
  programmaticKey = selKey(nodes);
  if (programmaticKey === selKey(figma.currentPage.selection)) return;
  try { figma.currentPage.selection = nodes; } catch (e) { /* 다른 페이지 노드 등 */ }
}

// ---------------------------------------------------------------- utilities

// 쉼표로 여러 단어를 받는다. 'img,banner' 와 'img, banner' 는 같다 → (?:img)|(?:banner)
// 이 칸은 정규식도 받으므로 {2,5} · [a,b] 처럼 괄호 안에 있는 쉼표는 나누지 않는다.
function toPatternSource(input) {
  var parts = [], cur = '', brace = 0, bracket = 0;
  for (var i = 0; i < input.length; i++) {
    var c = input[i];
    // 역슬래시로 이스케이프한 글자(\, 등)는 나누지 않고 그대로 둔다.
    if (c === '\\' && i + 1 < input.length) { cur += c + input[++i]; continue; }
    if (c === '[') bracket++;
    else if (c === ']' && bracket > 0) bracket--;
    else if (c === '{' && !bracket) brace++;
    else if (c === '}' && brace > 0 && !bracket) brace--;
    if (c === ',' && !brace && !bracket) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  // 빈 조각은 모든 이름에 맞아 버리므로 버린다 ('img,' · ', banner' 같은 입력).
  parts = parts.map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  return parts.map(function (p) { return '(?:' + p + ')'; }).join('|');
}

function safeRegExp(src) {
  try {
    return { re: new RegExp(src), err: null };
  } catch (e) {
    return { re: null, err: String((e && e.message) || e) };
  }
}

// 매칭된 노드를 찾으면 그 하위는 더 내려가지 않는다(중첩 중복 방지).
function collectMatches(roots, re, skipHidden) {
  var out = [];
  var seen = {};

  function walk(node) {
    var isPage = node.type === 'PAGE';
    if (!isPage && skipHidden && node.visible === false) return;
    if (!isPage && re.test(node.name)) {
      if (!seen[node.id]) {
        seen[node.id] = true;
        out.push(node);
      }
      return;
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }

  for (var r = 0; r < roots.length; r++) walk(roots[r]);
  return out;
}

// "_01, _02, _10" 이 사람 눈 순서대로 정렬되도록 하는 자연 정렬.
function naturalCompare(a, b) {
  var ax = [], bx = [];
  a.replace(/(\d+)|(\D+)/g, function (_, n, s) { ax.push([n ? parseInt(n, 10) : Infinity, s || '']); });
  b.replace(/(\d+)|(\D+)/g, function (_, n, s) { bx.push([n ? parseInt(n, 10) : Infinity, s || '']); });
  while (ax.length && bx.length) {
    var an = ax.shift(), bn = bx.shift();
    var diff = (an[0] - bn[0]) || (an[1] < bn[1] ? -1 : an[1] > bn[1] ? 1 : 0);
    if (diff) return diff;
  }
  return ax.length - bx.length;
}

function sanitize(name) {
  var out = name.replace(/[\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  return out.length ? out : 'untitled';
}

function uniqueName(used, base, ext) {
  var name = base + '.' + ext;
  if (!used[name]) { used[name] = true; return name; }
  var i = 2;
  while (used[base + '_' + i + '.' + ext]) i++;
  var picked = base + '_' + i + '.' + ext;
  used[picked] = true;
  return picked;
}

function describeTarget(mode) {
  var sel = liveRoots();
  if (mode === 'selection') {
    if (sel.length === 0) return '선택된 레이어 없음';
    if (sel.length === 1) return '선택: ' + sel[0].name;
    return '선택: ' + sel.length + '개 레이어';
  }
  if (sel.length === 0) return '선택된 프레임 없음';
  if (sel.length === 1) return '선택: ' + sel[0].name;
  return '선택: ' + sel.length + '개 레이어';
}

function toItems(nodes) {
  return nodes.map(function (n) {
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      w: Math.round(('width' in n) ? n.width : 0),
      h: Math.round(('height' in n) ? n.height : 0)
    };
  });
}

// ------------------------------------------------------------------- scan

function sortIfNeeded(nodes, sortByName) {
  if (sortByName) nodes.sort(function (a, b) { return naturalCompare(a.name, b.name); });
  return nodes;
}

// mode 'selection' — 캔버스에서 고른 레이어를 이름과 상관없이 그대로 쓴다.
// mode 'pattern'(기본) — 고른 프레임 아래에서 이름이 패턴에 맞는 레이어만 찾는다.
function scan(pattern, skipHidden, sortByName, mode) {
  if (mode === 'selection') {
    var sel = liveRoots();
    if (skipHidden) sel = sel.filter(function (n) { return n.visible !== false; });
    lastMatches = sortIfNeeded(sel, sortByName);
    // 목록 한 줄을 눌러 바뀐 선택이 있어도, 내보낼 대상 전체를 다시 보여 준다.
    selectQuietly(lastMatches.length ? lastMatches : liveRoots());
    figma.ui.postMessage({
      type: 'scan-result', mode: 'selection',
      target: describeTarget('selection'), items: toItems(lastMatches), error: null
    });
    return;
  }

  // 이름 패턴 모드는 선택된 프레임 안에서만 찾는다. 선택이 없거나 칸이 비었으면 찾지 않는다.
  // (전에는 선택이 없으면 페이지 전체를, 칸이 비면 보이지 않는 기본값 img 로 찾아
  //  아무것도 고르지 않았는데 레이어가 잡히는 것처럼 보였다.)
  var roots = liveRoots();
  var source = toPatternSource(pattern || '');
  if (roots.length === 0 || !source) {
    lastMatches = [];
    if (roots.length > 0) selectQuietly(roots);
    figma.ui.postMessage({
      type: 'scan-result', mode: 'pattern', target: describeTarget('pattern'), items: [], error: null,
      reason: roots.length === 0 ? 'no-selection' : 'empty-pattern'
    });
    return;
  }

  var parsed = safeRegExp(source);
  if (parsed.err) {
    lastMatches = [];
    selectQuietly(roots);
    figma.ui.postMessage({
      type: 'scan-result', mode: 'pattern',
      target: describeTarget('pattern'), items: [], error: '정규식 오류: ' + parsed.err
    });
    return;
  }

  lastMatches = sortIfNeeded(collectMatches(roots, parsed.re, !!skipHidden), sortByName);

  // 찾은 레이어를 선택해 레이어 패널에서도 그 레이어들만 강조되게 한다.
  // 못 찾았으면 고른 프레임을 그대로 보여 준다.
  selectQuietly(lastMatches.length ? lastMatches : roots);

  figma.ui.postMessage({
    type: 'scan-result', mode: 'pattern',
    target: describeTarget('pattern'), items: toItems(lastMatches), error: null
  });
}

// Auto layout 의 'Clip content'(clipsContent) 를 켠다. 이걸 꺼 두면 프레임 밖으로
// 삐져나온 자식까지 내보내져 결과 크기가 프레임과 달라진다.
// clipsContent 는 프레임 계열 노드에만 있고, 그룹 등에는 없다.
function applyClipContent(nodes) {
  var changed = 0;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!('clipsContent' in n) || n.clipsContent === true) continue;
    try {
      n.clipsContent = true;
      changed++;
    } catch (e) {
      // 잠긴 레이어 등 쓸 수 없는 경우는 건너뛴다.
    }
  }
  return changed;
}

// ----------------------------------------------------------------- export

// 슬라이스는 자기 내용이 없고 '그 영역에 보이는 것' 을 잘라 내보낸다. 그래서 슬라이스를
// 담은 상위 프레임 · 섹션의 배경(fills)까지 찍혀 투명이어야 할 곳이 배경색으로 채워진다.
// 내보내는 동안만 상위 컨테이너의 fills 를 비우고, 끝나면 그대로 되돌린다.
// 슬라이스가 아닌 레이어는 원래 자기 내용만 내보내므로 건드리지 않는다.
function hideContainerFills(node) {
  if (node.type !== 'SLICE') return null;
  var saved = [];
  for (var p = node.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p = p.parent) {
    if (!('fills' in p) || !Array.isArray(p.fills) || p.fills.length === 0) continue;
    try {
      saved.push({ node: p, fills: p.fills });
      p.fills = [];
    } catch (e) {
      saved.pop();   // 쓸 수 없는 노드는 건너뛴다
    }
  }
  if (!saved.length) return null;
  return function restore() {
    for (var i = saved.length - 1; i >= 0; i--) {
      try { saved[i].node.fills = saved[i].fills; } catch (e) {}
    }
  };
}

// 배율은 Figma Export 패널과 같은 세 가지 형태를 받는다.
//   '2' · '1.5x' → 배수,  '1200w' → 가로 px 고정,  '800h' → 세로 px 고정
function toConstraint(scale) {
  var v = String(scale).trim().toLowerCase();
  var m = /^(\d+)w$/.exec(v);
  if (m) return { type: 'WIDTH', value: Number(m[1]) };
  m = /^(\d+)h$/.exec(v);
  if (m) return { type: 'HEIGHT', value: Number(m[1]) };
  var x = parseFloat(v);
  return { type: 'SCALE', value: x > 0 ? x : 2 };
}

async function runExport(opts) {
  var fmt = opts.format || 'PNG';
  var ext = EXT[fmt] || 'png';
  var nodes = lastMatches.slice();

  if (nodes.length === 0) {
    figma.ui.postMessage({ type: 'done', ok: 0, errors: ['내보낼 레이어가 없습니다.'] });
    return;
  }

  var settings;
  if (fmt === 'PNG' || fmt === 'JPG' || fmt === 'WEBP') {
    settings = { format: figmaFormat(fmt), constraint: toConstraint(opts.scale) };
  } else {
    settings = { format: fmt };
  }

  var clipped = opts.clipContent === false ? 0 : applyClipContent(nodes);

  var used = {};
  var errors = [];
  var ok = 0;

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    figma.ui.postMessage({ type: 'progress', index: i, total: nodes.length, name: node.name });

    var filename = uniqueName(used, sanitize(node.name), ext);

    // 투명을 담을 수 있는 PNG · WebP 는 투명 배경으로: 슬라이스는 상위 프레임 배경까지
    // 함께 찍히므로 잠시 숨긴다. JPG 는 투명이 없어 그대로 둔다.
    var restore = (fmt === 'PNG' || fmt === 'WEBP') ? hideContainerFills(node) : null;
    try {
      var bytes = await node.exportAsync(settings);
      figma.ui.postMessage({ type: 'file', name: filename, bytes: bytes });
      ok++;
    } catch (e) {
      errors.push(node.name + ' — ' + String((e && e.message) || e));
    } finally {
      if (restore) restore();
    }
  }

  figma.ui.postMessage({ type: 'done', ok: ok, errors: errors, clipped: clipped });
}

// ------------------------------------------------- figma 네이티브 내보내기
// 플러그인은 파일을 디스크에 직접 쓸 수 없고, 다운로드는 파일마다 저장 창이
// 뜨는 데다 한 번에 열 수 있는 개수도 제한된다. 대신 대상 레이어에 Export
// 설정을 심고 한꺼번에 선택해 두면, 그다음은 Figma 자체 Export 기능이
// 폴더를 한 번만 묻고 개별 파일로 전부 저장해 준다.
function prepareNativeExport(opts) {
  var fmt = opts.format || 'PNG';
  var nodes = lastMatches.slice();

  if (nodes.length === 0) {
    figma.ui.postMessage({ type: 'native-ready', count: 0, errors: ['대상 레이어가 없습니다.'] });
    return;
  }

  // Figma 자체 Export 는 WebP 를 지원하지 않아 이 방식에서는 고를 수 없다.
  if (fmt === 'WEBP') {
    figma.ui.postMessage({
      type: 'native-ready', count: 0,
      errors: ['Figma 자체 Export 는 WebP 를 지원하지 않습니다. ZIP 방식을 써 주세요.']
    });
    return;
  }

  var setting = { format: fmt, suffix: '' };
  if (fmt === 'PNG' || fmt === 'JPG') setting.constraint = toConstraint(opts.scale);

  var clipped = opts.clipContent === false ? 0 : applyClipContent(nodes);

  var errors = [];
  var ok = 0;
  for (var i = 0; i < nodes.length; i++) {
    try {
      nodes[i].exportSettings = [setting];
      ok++;
    } catch (e) {
      errors.push(nodes[i].name + ' — ' + String((e && e.message) || e));
    }
  }

  selectQuietly(nodes);
  figma.viewport.scrollAndZoomIntoView(nodes);
  figma.ui.postMessage({ type: 'native-ready', count: ok, errors: errors, clipped: clipped });
}

// ------------------------------------------------------------------ events

var uiState = { pattern: DEFAULT_PATTERN, skipHidden: true, sortByName: true, mode: 'selection' };

function remember(msg) {
  if (typeof msg.pattern === 'string') uiState.pattern = msg.pattern;
  if (typeof msg.skipHidden === 'boolean') uiState.skipHidden = msg.skipHidden;
  if (typeof msg.sortByName === 'boolean') uiState.sortByName = msg.sortByName;
  if (msg.mode === 'pattern' || msg.mode === 'selection') uiState.mode = msg.mode;
}

function onMessage(msg) {
  if (!msg) return;

  switch (msg.type) {
    case 'init':
      // 저장된 UI 설정도 함께 보낸다. UI 가 적용한 뒤 다시 scan 을 요청한다.
      figma.ui.postMessage({ type: 'defaults', pattern: DEFAULT_PATTERN, prefs: prefs });
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
      break;

    case 'scan':
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
      break;

    case 'export':
      // 내보내기 직전 최신 상태로 다시 스캔해 선택 변경을 반영한다.
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
      runExport(msg);
      break;

    case 'native-export':
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
      prepareNativeExport(msg);
      break;

    case 'select': {
      var node = lastMatches.filter(function (n) { return n.id === msg.id; })[0];
      if (node) {
        // 목록에서 한 줄을 눌러도 목록이 그 하나로 줄어들지 않도록 조용히 선택한다.
        selectQuietly([node]);
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      break;
    }

    case 'resize':
      // UI 가 요청한 크기로 창을 줄이거나 늘린다.
      if (typeof msg.w === 'number' && typeof msg.h === 'number') {
        figma.ui.resize(Math.max(240, Math.round(msg.w)), Math.max(96, Math.round(msg.h)));
      }
      break;

    case 'save-prefs':
      // 저장이 실패해도 내보내기 동작에는 영향이 없으니 조용히 넘긴다.
      if (msg.prefs && typeof msg.prefs === 'object') {
        prefs = msg.prefs;
        figma.clientStorage.setAsync(PREFS_KEY, msg.prefs).catch(function () {});
      }
      break;

    case 'notify':
      figma.notify(msg.message);
      break;

    case 'close':
      figma.closePlugin();
      break;
  }
}

figma.on('selectionchange', function () {
  if (!uiReady) return;
  var sel = figma.currentPage.selection;
  if (programmaticKey !== null && selKey(sel) === programmaticKey) return;   // 플러그인이 바꾼 선택
  programmaticKey = null;
  userRoots = sel.slice();
  scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
});

figma.on('currentpagechange', function () {
  if (!uiReady) return;
  programmaticKey = null;
  userRoots = figma.currentPage.selection.slice();
  scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
});

// ------------------------------------------------------------------- boot
// 저장된 설정을 먼저 읽고 창을 연다. 그래야 축소 상태로 닫았을 때 처음부터 작게 열린다.
figma.clientStorage.getAsync(PREFS_KEY)
  .then(function (p) { prefs = p || null; }, function () { prefs = null; })
  .then(function () {
    var size = initialSize(prefs);
    figma.showUI(__html__, { width: size.w, height: size.h, title: "Konny Figma Image Exporter" });
    figma.ui.onmessage = onMessage;
    uiReady = true;
  });
