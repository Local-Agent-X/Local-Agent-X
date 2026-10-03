// ── App IDE — the preview page's half of the picker and error capture ──
// Runs INSIDE an agent-built app page on the agent origin. The server injects
// it after apps-error-pipe-core.js (src/server/ide-frame-bridge.ts); the UI is
// another origin and cannot reach into this document. So this page posts its
// runtime errors and element picks to the UI's origins and nowhere else, and
// takes picker on/off orders only from its own parent at one of those origins.
// The UI half is apps-ide-picker.js and apps-ide-errors.js.
// Keep this file to comments + the single top-level function: the server
// injects its body verbatim inside a script tag, so a closing-script-tag
// sequence anywhere here would cut the block short.
// test/agent-origin-frames.test.ts guards this.

function __laxInstallIdeFrameBridge(uiOrigins) {
  // Opened on its own (a browser tab, the phone) there is no UI to talk to.
  if (window.parent === window || window.__laxIdeFrameBridge) return;
  window.__laxIdeFrameBridge = true;

  // A message whose target origin is not the parent's is dropped by the
  // browser, so exactly one of these reaches the UI.
  function post(msg) {
    for (var i = 0; i < uiOrigins.length; i++) {
      try { window.parent.postMessage(msg, uiOrigins[i]); } catch (e) {}
    }
  }

  __laxInstallErrorPipe(post);

  var OUTLINE_COLOR = '#40f0f0';
  var pickerOn = false;
  var current = null;
  var savedOutline = '';
  var savedCursor = '';

  function isUtilityClass(c) {
    if (!c) return true;
    if (c[0] === '_') return true;
    if (/^(is-|has-|js-)/.test(c)) return true;
    if (/^(active|hover|focus|open|selected|disabled|hidden|visible)$/.test(c)) return true;
    return false;
  }

  function isStableId(id) {
    if (!id) return false;
    // Skip React/Vue/etc generated ids like ":r12:" or "__123"
    return /^[A-Za-z][\w-]*$/.test(id);
  }

  function partFor(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && isStableId(el.id)) return '#' + el.id;
    var classes = (el.className && typeof el.className === 'string')
      ? el.className.split(/\s+/).filter(function(c){ return c && !isUtilityClass(c); })
      : [];
    if (classes.length) return tag + '.' + classes.slice(0, 3).join('.');
    return tag;
  }

  function buildSelector(el) {
    if (!el || !el.tagName) return '';
    var parts = [];
    var node = el;
    for (var hop = 0; hop < 3 && node && node.nodeType === 1; hop++) {
      var p = partFor(node);
      parts.unshift(p);
      // Stop walking once we've hit a unique id
      if (p[0] === '#') break;
      // If selector is already unique in the document, stop
      try {
        if (document.querySelectorAll(parts.join(' ')).length === 1) break;
      } catch (e) { /* invalid selector — keep walking */ }
      node = node.parentElement;
    }
    var sel = parts.join(' ');
    // Last resort: append :nth-of-type to the leaf if still ambiguous
    try {
      if (document.querySelectorAll(sel).length > 1 && el.parentElement) {
        var idx = 1, sib = el;
        while ((sib = sib.previousElementSibling)) {
          if (sib.tagName === el.tagName) idx++;
        }
        sel = sel + ':nth-of-type(' + idx + ')';
      }
    } catch (e) {}
    return sel;
  }

  function describe(el) {
    var sel = buildSelector(el);
    var raw = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    var text = raw.length > 60 ? raw.slice(0, 57) + '...' : raw;
    var r = el.getBoundingClientRect();
    var dims = Math.round(r.width) + 'x' + Math.round(r.height) + 'px';
    return { type: 'lax-ide-pick', selector: sel, text: text, dims: dims };
  }

  function setOutline(el) {
    if (current === el) return;
    clearOutline();
    if (!el || el === document.body || el === document.documentElement) return;
    current = el;
    savedOutline = el.style.outline;
    el.style.outline = '2px solid ' + OUTLINE_COLOR;
    el.style.outlineOffset = '-2px';
  }

  function clearOutline() {
    if (current) {
      try { current.style.outline = savedOutline || ''; current.style.outlineOffset = ''; } catch (e) {}
    }
    current = null;
    savedOutline = '';
  }

  function onOver(e) { setOutline(e.target); }
  function onOut(e) { if (e.target === current) clearOutline(); }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    post(describe(e.target));
    stopPicker();
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      post({ type: 'lax-ide-pick-cancel' });
      stopPicker();
    }
  }

  function startPicker() {
    if (pickerOn) return;
    pickerOn = true;
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    savedCursor = document.body ? document.body.style.cursor : '';
    if (document.body) document.body.style.cursor = 'crosshair';
  }

  function stopPicker() {
    if (!pickerOn) return;
    pickerOn = false;
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    clearOutline();
    if (document.body) document.body.style.cursor = savedCursor || '';
  }

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent || uiOrigins.indexOf(e.origin) === -1) return;
    var d = e.data;
    if (!d || d.type !== 'lax-ide-picker') return;
    if (d.on) startPicker(); else stopPicker();
  });
}
