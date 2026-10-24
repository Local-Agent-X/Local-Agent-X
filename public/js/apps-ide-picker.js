// ── App IDE — click-to-edit element picker (the shell's half) ──
// Toggle a picker, click any element in the preview iframe, and a description
// of it gets dropped into the chat input so the user can describe what to
// change about it.
//
// The preview is an agent-built page on the agent origin
// (src/server/agent-origin.ts), so the shell cannot reach into its document.
// The page runs the picker itself (apps-ide-frame-bridge.js, which the server
// injects); the shell turns it on and off by postMessage addressed to the agent
// origin, and takes picks only from a preview frame's own window at that
// origin. Nothing on disk is modified.
//
// Two surfaces show an app's preview and share this picker: the App IDE, and
// the right panel's Preview tab (preview-tab.js), whose picks go into the main
// chat's composer. Each names its frame, the input a pick fills and its button.

const PICKER_SURFACES = {
  ide: { frame: 'ide-preview-frame', input: 'ide-chat-input', button: '.ide-topbar-btn[onclick*="ideTogglePicker"]' },
  preview: { frame: 'preview-tab-frame', input: 'msg-input', button: '#preview-picker-btn' },
};
const _pickerOn = { ide: false, preview: false };

function togglePicker(surface, on = !_pickerOn[surface]) {
  _pickerOn[surface] = on;
  const btn = document.querySelector(PICKER_SURFACES[surface].button);
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  _postPicker(surface, on);
}

function ideTogglePicker() { togglePicker('ide'); }

function _previewWindowOf(surface) {
  const frame = document.getElementById(PICKER_SURFACES[surface].frame);
  return frame ? frame.contentWindow : null;
}

/** The surface whose preview frame sent `e`, from the agent origin; null for any other window. */
function _pickerSurfaceOf(e) {
  if (!laxAgent.origin || e.origin !== laxAgent.origin) return null;
  for (const surface of Object.keys(PICKER_SURFACES)) {
    const preview = _previewWindowOf(surface);
    if (preview && e.source === preview) return surface;
  }
  return null;
}

// The test every message from the App IDE's preview passes: sent by that
// frame's own window, from the agent origin. A pinned app, a page nested inside
// the preview, or any other window is ignored. apps-ide-errors.js shares it.
function ideMessageFromPreview(e) {
  return _pickerSurfaceOf(e) === 'ide';
}

function _postPicker(surface, on) {
  const preview = _previewWindowOf(surface);
  if (preview && laxAgent.origin) preview.postMessage({ type: 'lax-ide-picker', on }, laxAgent.origin);
}

// Called after a preview iframe's load event: the new document starts with the
// picker off, so turn it back on if the user left it on (edits reload the
// preview).
function pickerOnPreviewLoad(surface) {
  if (_pickerOn[surface]) _postPicker(surface, true);
}
function _ideOnPreviewLoad() { pickerOnPreviewLoad('ide'); }

window.addEventListener('message', (e) => {
  const surface = _pickerSurfaceOf(e);
  if (!surface) return;
  const d = e.data;
  if (!d) return;
  // Escape in the preview stopped its picker; turn the button off to match.
  if (d.type === 'lax-ide-pick-cancel') {
    if (_pickerOn[surface]) togglePicker(surface, false);
    return;
  }
  if (d.type !== 'lax-ide-pick' || typeof d.selector !== 'string') return;
  const input = document.getElementById(PICKER_SURFACES[surface].input);
  if (!input) return;
  const dims = typeof d.dims === 'string' && d.dims ? ` (${d.dims})` : '';
  const text = typeof d.text === 'string' && d.text ? ` ("${d.text}")` : '';
  const prefix = 'Edit this element on the page: `' + d.selector + '`' + text + dims + '. ';
  // Preserve anything the user already started typing
  const existing = input.value || '';
  input.value = prefix + existing;
  // The composer sizes itself on input events.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  // Turn picker off so the next iframe click acts normally
  if (_pickerOn[surface]) togglePicker(surface, false);
});

window.togglePicker = togglePicker;
window.pickerOnPreviewLoad = pickerOnPreviewLoad;
window.ideTogglePicker = ideTogglePicker;
window._ideOnPreviewLoad = _ideOnPreviewLoad;
