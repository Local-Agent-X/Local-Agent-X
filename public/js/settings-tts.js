// ── Settings: TTS engine + cloned-voice picker + voice visuals ──
//
// TTS engine selection (browser / Kokoro / Chatterbox / sidecar) plus
// the cloned-voice picker that surfaces only when the selected engine
// supports clones. initVoiceSettings does the page-load hydration.

// ── TTS engine selection + cloned-voice picker ──
//
// Replaces the legacy XTTS Record/Upload UI (dead — :7862 standalone server
// was removed). Voice cloning now lives in the chat-page voice picker
// (+ Add zero-shot, + Train new voice). Settings just lets the user pick
// which engine + which clone they want for chat replies.

// Toggle the right sub-picker based on the selected engine. Built-in engines
// (kokoro/piper) show the Kokoro voice list; cloning engines show the clone
// picker populated from window._chatterboxVoices / _sovitsVoices (refreshed
// by refreshTtsClonePicker below). Browser/none hide both — nothing to pick.
function onTtsEngineChange(engine) {
  const builtin = document.getElementById('tts-voice-field');
  const clone = document.getElementById('tts-clone-field');
  const isClone = engine === 'chatterbox' || engine === 'sovits';
  const isBuiltin = engine === 'kokoro' || engine === 'piper';
  if (builtin) builtin.style.display = isBuiltin ? '' : 'none';
  if (clone) clone.style.display = isClone ? '' : 'none';
  if (isClone) refreshTtsClonePicker(engine);
}

// Populate the clone <select> from the live arrays already maintained by
// chat.js:refreshClonedVoices (which polls /api/voices/tier on chat init).
// Settings page also calls that function on load — see initVoiceSettings.
function refreshTtsClonePicker(engine) {
  const sel = document.getElementById('cfg-tts-clone');
  if (!sel) return;
  const list = engine === 'chatterbox'
    ? (window._chatterboxVoices || [])
    : (window._sovitsVoices || []);
  const prefix = engine === 'chatterbox' ? 'cb:' : 'sv:';
  sel.innerHTML = '<option value="">-- pick a clone --</option>' +
    list.map(c => {
      const star = c.fine_tuned ? ' ★' : '';
      const v = prefix + c.id;
      return `<option value="${v}">${(c.name || c.id).replace(/[<>"']/g, '')}${star}</option>`;
    }).join('');
  // Restore previous selection if it matches the current engine
  try {
    const saved = localStorage.getItem('lax_voice') || '';
    if (saved.startsWith(prefix)) sel.value = saved;
  } catch {}
}

// Fetch /api/voices/tier on settings load so we know which sidecars are
// reachable, then enable the matching options in the engine dropdown.
async function initVoiceSettings() {
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/voices/tier') : fetch('/api/voices/tier'));
    if (!r.ok) return;
    const tier = await r.json();
    const cbReady = !!(tier.chatterbox && tier.chatterbox.ready);
    const svReady = !!(tier.sovits && tier.sovits.ready);
    window._studioTierReady = cbReady;
    window._sovitsTierReady = svReady;
    // Pull the actual clone lists if their sidecars are up
    if (cbReady) {
      try {
        const cr = await apiFetch('/api/voices/chatterbox');
        if (cr.ok) {
          const d = await cr.json();
          window._chatterboxVoices = Array.isArray(d?.clones) ? d.clones : [];
        }
      } catch {}
    }
    if (svReady) {
      try {
        const sr = await apiFetch('/api/voices/sovits');
        if (sr.ok) {
          const d = await sr.json();
          window._sovitsVoices = Array.isArray(d?.clones) ? d.clones : [];
        }
      } catch {}
    }
    // Enable the clone-engine options if either sidecar is up
    const group = document.getElementById('cfg-tts-clone-group');
    const cbOpt = document.getElementById('cfg-tts-engine-cb');
    const svOpt = document.getElementById('cfg-tts-engine-sv');
    if (group && (cbReady || svReady)) group.style.display = '';
    if (cbOpt) cbOpt.disabled = !cbReady;
    if (svOpt) svOpt.disabled = !svReady;
    // Re-trigger engine-change to refresh the sub-picker if a cloning engine
    // was already saved from a prior session.
    const engSel = document.getElementById('cfg-tts-engine');
    if (engSel) onTtsEngineChange(engSel.value);
    // Re-render the unified Media-tab picker once clone lists landed so
    // sv:/cb: voices (e.g. "Optimus") show up under Python sidecar.
    if (typeof loadVoicePicker === 'function') {
      try {
        const r2 = await (typeof apiFetch === 'function' ? apiFetch('/api/settings') : fetch('/api/settings'));
        const s2 = r2.ok ? await r2.json() : {};
        loadVoicePicker(s2);
      } catch { loadVoicePicker({}); }
    }
  } catch { /* silent — Settings page works fine without sidecars */ }
}

// Auto-init on page load. Settings.html may load this script before chat.js,
// so we guard against the DOM not being ready yet.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initVoiceSettings(); initVoiceVisualsToggle(); });
} else {
  initVoiceSettings();
  initVoiceVisualsToggle();
}

// Persist the visualizer toggle to /api/settings. Server stores it on the
// live LAXConfig (voice_visuals_enabled) and the next voice turn picks it
// up via the existing config hot-reload path. Default ON.
async function initVoiceVisualsToggle() {
  const el = document.getElementById('cfg-voice-visuals');
  if (!el) return;
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/settings') : fetch('/api/settings'));
    if (r.ok) {
      const s = await r.json();
      // Treat undefined as ON (default)
      el.checked = s.voice_visuals_enabled !== false;
    }
  } catch { /* leave default checked state */ }
}
function onVoiceVisualsToggle(checked) {
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('sax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ voice_visuals_enabled: !!checked }),
  }).catch(() => {});
}

