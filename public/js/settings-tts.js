// ── Settings: TTS engine + cloned-voice picker + voice visuals ──
//
// TTS engine selection (browser / Kokoro / Chatterbox / sidecar) plus
// the cloned-voice picker that surfaces only when the selected engine
// supports clones. initVoiceSettings does the page-load hydration.

// ── TTS engine selection + cloned-voice picker ──
//
// Replaces the legacy XTTS Record/Upload UI (dead — :7862 standalone server
// was removed). Voice cloning now lives in the chat-page voice picker
// (+ Add zero-shot). Settings just lets the user pick which engine +
// which clone they want for chat replies.

// Toggle the right sub-picker based on the selected engine. Built-in engines
// (kokoro/piper) show the Kokoro voice list; Chatterbox shows the clone
// picker populated from window._chatterboxVoices (refreshed by
// refreshTtsClonePicker below). Browser/none hide both — nothing to pick.
function onTtsEngineChange(engine) {
  const builtin = document.getElementById('tts-voice-field');
  const clone = document.getElementById('tts-clone-field');
  const isClone = engine === 'chatterbox';
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
  const list = window._chatterboxVoices || [];
  const prefix = 'cb:';
  sel.innerHTML = '<option value="">-- pick a clone --</option>' +
    list.map(c => {
      const v = prefix + c.id;
      return `<option value="${v}">${(c.name || c.id).replace(/[<>"']/g, '')}</option>`;
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
    window._studioTierReady = cbReady;
    // Pull the actual clone list if the sidecar is up
    if (cbReady) {
      try {
        const cr = await apiFetch('/api/voices/chatterbox');
        if (cr.ok) {
          const d = await cr.json();
          window._chatterboxVoices = Array.isArray(d?.clones) ? d.clones : [];
        }
      } catch {}
    }
    // Enable the clone-engine option if the sidecar is up
    const group = document.getElementById('cfg-tts-clone-group');
    const cbOpt = document.getElementById('cfg-tts-engine-cb');
    if (group && cbReady) group.style.display = '';
    if (cbOpt) cbOpt.disabled = !cbReady;
    // Re-trigger engine-change to refresh the sub-picker if a cloning engine
    // was already saved from a prior session.
    const engSel = document.getElementById('cfg-tts-engine');
    if (engSel) onTtsEngineChange(engSel.value);
    // Re-render the unified Media-tab picker once clone lists landed so
    // cb: voices show up under Python sidecar.
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
  document.addEventListener('DOMContentLoaded', () => { initVoiceSettings(); initVoiceVisualsToggle(); initBridgeVoicePreference(); });
} else {
  initVoiceSettings();
  initVoiceVisualsToggle();
  initBridgeVoicePreference();
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
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('lax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ voice_visuals_enabled: !!checked }),
  }).catch(() => {});
}

// ── Bridge voice preference (Telegram/WhatsApp synth chain order) ──
async function initBridgeVoicePreference() {
  const el = document.getElementById('cfg-bridge-voice-preference');
  if (!el) return;
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/settings') : fetch('/api/settings'));
    if (r.ok) {
      const s = await r.json();
      const v = s.bridgeVoicePreference;
      if (v === 'auto' || v === 'chatterbox' || v === 'lite' || v === 'xai') el.value = v;
    }
  } catch { /* leave default 'auto' */ }
}
function onBridgeVoicePreferenceChange(value) {
  if (!['auto','chatterbox','lite','xai'].includes(value)) return;
  const tok = (new URLSearchParams(location.search).get('token') || localStorage.getItem('lax_token') || '');
  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ bridgeVoicePreference: value }),
  }).catch(() => {});
}

