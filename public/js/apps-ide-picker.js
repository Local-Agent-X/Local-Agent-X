// ── App IDE — click-to-edit element picker (the shell's half) ──
// Toggle a picker, click any element in the preview iframe, and a description
// of it gets dropped into the chat input so the user can describe what to
// change about it.
//
// The preview is an agent-built page on the agent origin
// (src/server/agent-origin.ts), so the shell cannot reach into its document.
// The page runs the picker itself (apps-ide-frame-bridge.js, which the server
// injects); the shell turns it on and off by postMessage addressed to the agent
// origin, and takes picks only from the preview frame's own window at that
// origin. Nothing on disk is modified.

let _idePickerOn = false;

function ideTogglePicker() {
  _idePickerOn = !_idePickerOn;
  const btn = document.querySelector('.ide-topbar-btn[onclick*="ideTogglePicker"]');
  if (btn) btn.classList.toggle('active', _idePickerOn);
  _idePostPicker(_idePickerOn);
}

function _idePreviewWindow() {
  const frame = document.getElementById('ide-preview-frame');
  return frame ? frame.contentWindow : null;
}

// The test every message from the preview passes: sent by the preview frame's
// own window, from the agent origin. A pinned app, a page nested inside the
// preview, or any other window is ignored. apps-ide-errors.js shares it.
function ideMessageFromPreview(e) {
  const preview = _idePreviewWindow();
  return !!preview && e.source === preview && !!laxAgent.origin && e.origin === laxAgent.origin;
}

function _idePostPicker(on) {
  const preview = _idePreviewWindow();
  if (preview && laxAgent.origin) preview.postMessage({ type: 'lax-ide-picker', on }, laxAgent.origin);
}

// Called after the preview iframe's load event: the new document starts with
// the picker off, so turn it back on if the user left it on (edits reload the
// preview via ideRefreshPreview).
function _ideOnPreviewLoad() {
  if (_idePickerOn) _idePostPicker(true);
}

window.addEventListener('message', (e) => {
  if (!ideMessageFromPreview(e)) return;
  const d = e.data;
  if (!d) return;
  // Escape in the preview stopped its picker; turn the button off to match.
  if (d.type === 'lax-ide-pick-cancel') {
    if (_idePickerOn) ideTogglePicker();
    return;
  }
  if (d.type !== 'lax-ide-pick' || typeof d.selector !== 'string') return;
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const dims = typeof d.dims === 'string' && d.dims ? ` (${d.dims})` : '';
  const text = typeof d.text === 'string' && d.text ? ` ("${d.text}")` : '';
  const prefix = 'Edit this element on the page: `' + d.selector + '`' + text + dims + '. ';
  // Preserve anything the user already started typing
  const existing = input.value || '';
  input.value = prefix + existing;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  // Turn picker off so the next iframe click acts normally
  if (_idePickerOn) ideTogglePicker();
});

window.ideTogglePicker = ideTogglePicker;
window._ideOnPreviewLoad = _ideOnPreviewLoad;
