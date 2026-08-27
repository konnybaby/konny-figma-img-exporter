// Konny Image Exporter — Figma plugin (main thread)
// 선택한 프레임 하위에서 `KO???_img_...` 형식의 레이어만 골라 일괄 내보내기.

var DEFAULT_PATTERN = '^KO[A-Za-z0-9]{3}_img_';

var EXT = { PNG: 'png', JPG: 'jpg', SVG: 'svg', PDF: 'pdf' };

var lastMatches = [];

figma.showUI(__html__, { width: 440, height: 680, title: "Konny Image Exporter" });

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

function describeTarget() {
  var sel = figma.currentPage.selection;
  if (sel.length === 0) return '선택 없음 → 현재 페이지 전체 (' + figma.currentPage.name + ')';
  if (sel.length === 1) return '선택: ' + sel[0].name;
  return '선택: ' + sel.length + '개 레이어';
}

// ------------------------------------------------------------------- scan

function scan(pattern, skipHidden, sortByName) {
  var parsed = safeRegExp(pattern || DEFAULT_PATTERN);
  if (parsed.err) {
    lastMatches = [];
    figma.ui.postMessage({ type: 'scan-result', target: describeTarget(), items: [], error: '정규식 오류: ' + parsed.err });
    return;
  }

  var matches = collectMatches(getRoots(), parsed.re, !!skipHidden);
  if (sortByName) matches.sort(function (a, b) { return naturalCompare(a.name, b.name); });
  lastMatches = matches;

  var items = matches.map(function (n) {
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      w: Math.round(('width' in n) ? n.width : 0),
      h: Math.round(('height' in n) ? n.height : 0)
    };
  });

  figma.ui.postMessage({ type: 'scan-result', target: describeTarget(), items: items, error: null });
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
  if (fmt === 'PNG' || fmt === 'JPG') {
    settings = { format: fmt, constraint: toConstraint(opts.scale) };
  } else {
    settings = { format: fmt };
  }

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

  figma.ui.postMessage({ type: 'done', ok: ok, errors: errors });
}

// ------------------------------------------------------------------ events

var uiState = { pattern: DEFAULT_PATTERN, skipHidden: true, sortByName: true };

function remember(msg) {
  if (typeof msg.pattern === 'string') uiState.pattern = msg.pattern;
  if (typeof msg.skipHidden === 'boolean') uiState.skipHidden = msg.skipHidden;
  if (typeof msg.sortByName === 'boolean') uiState.sortByName = msg.sortByName;
}

figma.ui.onmessage = function (msg) {
  if (!msg) return;

  switch (msg.type) {
    case 'init':
      figma.ui.postMessage({ type: 'defaults', pattern: DEFAULT_PATTERN });
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName);
      break;

    case 'scan':
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName);
      break;

    case 'export':
      // 내보내기 직전 최신 상태로 다시 스캔해 선택 변경을 반영한다.
      remember(msg);
      scan(uiState.pattern, uiState.skipHidden, uiState.sortByName);
      runExport(msg);
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
  scan(uiState.pattern, uiState.skipHidden, uiState.sortByName);
});
