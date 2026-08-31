// Konny Figma Image Exporter — Figma plugin (main thread)
// 선택한 프레임 하위에서 `KO???_img_...` 형식의 레이어만 골라 일괄 내보내기.

var DEFAULT_PATTERN = '^KO[A-Za-z0-9]{3}_img_';

var EXT = { PNG: 'png', JPG: 'jpg', WEBP: 'webp', SVG: 'svg', PDF: 'pdf' };

// Figma 는 WebP 를 내보내지 못한다. PNG 로 받아 UI 에서 다시 인코딩한다.
function figmaFormat(fmt) {
  return fmt === 'WEBP' ? 'PNG' : fmt;
}

var lastMatches = [];

figma.showUI(__html__, { width: 440, height: 720, title: "Konny Figma Image Exporter" });

// ---------------------------------------------------------------- utilities

function safeRegExp(src) {
  try {
    return { re: new RegExp(src), err: null };
  } catch (e) {
    return { re: null, err: String((e && e.message) || e) };
  }
}

function getRoots() {
  var sel = figma.currentPage.selection;
  if (sel.length > 0) return sel.slice();
  return [figma.currentPage];
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
  var sel = figma.currentPage.selection;
  if (mode === 'selection') {
    if (sel.length === 0) return '선택된 레이어 없음';
    if (sel.length === 1) return '선택: ' + sel[0].name;
    return '선택: ' + sel.length + '개 레이어';
  }
  if (sel.length === 0) return '선택 없음 → 현재 페이지 전체 (' + figma.currentPage.name + ')';
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
    var sel = figma.currentPage.selection.slice();
    if (skipHidden) sel = sel.filter(function (n) { return n.visible !== false; });
    lastMatches = sortIfNeeded(sel, sortByName);
    figma.ui.postMessage({
      type: 'scan-result', mode: 'selection',
      target: describeTarget('selection'), items: toItems(lastMatches), error: null
    });
    return;
  }

  var parsed = safeRegExp(pattern || DEFAULT_PATTERN);
  if (parsed.err) {
    lastMatches = [];
    figma.ui.postMessage({
      type: 'scan-result', mode: 'pattern',
      target: describeTarget('pattern'), items: [], error: '정규식 오류: ' + parsed.err
    });
    return;
  }

  lastMatches = sortIfNeeded(collectMatches(getRoots(), parsed.re, !!skipHidden), sortByName);
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

// 배율은 '2' 같은 배수와 '1000w' 같은 고정 가로폭 두 가지를 받는다.
function toConstraint(scale) {
  var m = /^(\d+)w$/.exec(String(scale));
  if (m) return { type: 'WIDTH', value: Number(m[1]) };
  return { type: 'SCALE', value: Number(scale) || 2 };
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

    try {
      var bytes = await node.exportAsync(settings);
      figma.ui.postMessage({ type: 'file', name: filename, bytes: bytes });
      ok++;
    } catch (e) {
      errors.push(node.name + ' — ' + String((e && e.message) || e));
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

  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  figma.ui.postMessage({ type: 'native-ready', count: ok, errors: errors, clipped: clipped });
  if (ok) figma.notify('선택을 대상 레이어 ' + ok + '개로 바꿨습니다 — 오른쪽 패널의 Export ' + ok + ' layers 를 누르세요 (캔버스를 클릭하면 선택이 풀립니다)', { timeout: 8000 });
}

// ------------------------------------------------------------------ events

var uiState = { pattern: DEFAULT_PATTERN, skipHidden: true, sortByName: true, mode: 'selection' };

function remember(msg) {
  if (typeof msg.pattern === 'string') uiState.pattern = msg.pattern;
  if (typeof msg.skipHidden === 'boolean') uiState.skipHidden = msg.skipHidden;
  if (typeof msg.sortByName === 'boolean') uiState.sortByName = msg.sortByName;
  if (msg.mode === 'pattern' || msg.mode === 'selection') uiState.mode = msg.mode;
}

figma.ui.onmessage = function (msg) {
  if (!msg) return;

  switch (msg.type) {
    case 'init':
      figma.ui.postMessage({ type: 'defaults', pattern: DEFAULT_PATTERN });
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
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      break;
    }

    case 'notify':
      figma.notify(msg.message);
      break;

    case 'close':
      figma.closePlugin();
      break;
  }
};

figma.on('selectionchange', function () {
  scan(uiState.pattern, uiState.skipHidden, uiState.sortByName, uiState.mode);
});
