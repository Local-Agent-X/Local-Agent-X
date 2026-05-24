// ── App IDE — click-to-edit element picker ──
// Lovable/v0-style: toggle a picker, click any element in the preview
// iframe, and a description of it gets dropped into the chat input so the
// user can describe what to change about it.
//
// Iframe is same-origin (sandbox includes allow-same-origin), so we inject
// a <script> node into the iframe's document instead of running anything
// the user's app files own. Nothing on disk is modified.

let _idePickerOn = false;

function ideTogglePicker() {
  _idePickerOn = !_idePickerOn;
  const btn = document.querySelector('.ide-topbar-btn[onclick*="ideTogglePicker"]');
  if (btn) btn.classList.toggle('active', _idePickerOn);
  if (_idePickerOn) {
    _ideInjectPicker();
  } else {
    _ideTeardownPicker();
  }
}

// Re-injected on every preview reload while the picker is on, so the
// outline/click handler survives the user editing files (which triggers
// ideRefreshPreview → frame.src = appUrl + '?_t=…').
function _ideInjectPicker() {
  const frame = document.getElementById('ide-preview-frame');
  if (!frame) return;
  let doc;
  try { doc = frame.contentDocument; } catch { return; }
  // srcdoc placeholder ("Waiting for build...") has no body to pick from
  if (!doc || !doc.body || !doc.documentElement) return;
  // Idempotent: if our flag is already set, the previous load's script is
  // still live — just leave it alone.
  try { if (frame.contentWindow && frame.contentWindow.__laxPicker) return; } catch { return; }
  const s = doc.createElement('script');
  s.id = '__lax-picker-script';
  s.textContent = _idePickerSource();
  doc.documentElement.appendChild(s);
}

function _ideTeardownPicker() {
  const frame = document.getElementById('ide-preview-frame');
  if (!frame) return;
  try {
    const w = frame.contentWindow;
    if (w && typeof w.__laxPickerOff === 'function') w.__laxPickerOff();
  } catch { /* cross-origin or torn down — fine */ }
}

// Called from _ideDoRefresh after the iframe load event fires. Picker
// must re-attach to the new document because the old window is gone.
function _ideOnPreviewLoad() {
  if (_idePickerOn) _ideInjectPicker();
}

// Listen for picks from the iframe. Filter by message type so we don't
// trample on other postMessage traffic (none today, but cheap insurance).
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || d.type !== 'lax-ide-pick') return;
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const dims = d.dims ? ` (${d.dims})` : '';
  const text = d.text ? ` ("${d.text}")` : '';
  const prefix = 'Edit this element on the page: `' + d.selector + '`' + text + dims + '. ';
  // Preserve anything the user already started typing
  const existing = input.value || '';
  input.value = prefix + existing;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  // Turn picker off so the next iframe click acts normally
  if (_idePickerOn) ideTogglePicker();
});

// Iframe-side script. Stringified IIFE so we can inject it via a script
// node's textContent (no eval, no string handlers). Communicates back via
// window.parent.postMessage.
function _idePickerSource() {
  return '(' + function() {
    if (window.__laxPicker) return;
    window.__laxPicker = true;

    var OUTLINE_COLOR = '#40f0f0';
    var current = null;
    var savedOutline = '';
    var savedCursor = document.body ? document.body.style.cursor : '';

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
        } catch { /* invalid selector — keep walking */ }
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
      } catch {}
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
        try { current.style.outline = savedOutline || ''; current.style.outlineOffset = ''; } catch {}
      }
      current = null;
      savedOutline = '';
    }

    function onOver(e) { setOutline(e.target); }
    function onOut(e) { if (e.target === current) clearOutline(); }
    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      var msg = describe(e.target);
      try { window.parent.postMessage(msg, '*'); } catch {}
      window.__laxPickerOff();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        try { window.parent.postMessage({ type: 'lax-ide-pick-cancel' }, '*'); } catch {}
        window.__laxPickerOff();
      }
    }

    window.__laxPickerOff = function() {
      if (!window.__laxPicker) return;
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      clearOutline();
      if (document.body) document.body.style.cursor = savedCursor || '';
      window.__laxPicker = false;
      var s = document.getElementById('__lax-picker-script');
      if (s && s.parentNode) s.parentNode.removeChild(s);
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    if (document.body) document.body.style.cursor = 'crosshair';
  }.toString() + ')();';
}

window.ideTogglePicker = ideTogglePicker;
window._ideOnPreviewLoad = _ideOnPreviewLoad;
