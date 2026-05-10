// ── Settings: Voice engine selection + Tier 4 advanced + PTT ──
//
// Voice engine picker (Lite / Studio / Realtime), Tier 4 fine-grained
// settings (voice / speed / device / dtype + whisper), and the
// push-to-talk hotkey capture / mode UI.

// ── Voice Engine selection ──
// Picks the backend (tier4 / python / cpu_fallback). Persists immediately to
// settings.json via /api/settings so the next voice session picks it up — no
// restart needed. The status row reflects what the server resolved.
async function onVoiceEngineChange(engine) {
  if (!engine) return;
  try {
    await (typeof apiPost === 'function' ? apiPost('/api/settings', { voiceEngine: engine }) : fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceEngine: engine }) }));
    // Mirror to localStorage so a fresh load picks up the same choice before
    // the server fetch races back.
    try {
      const saved = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      saved.voiceEngine = engine;
      localStorage.setItem('sax_settings', JSON.stringify(saved));
    } catch {}
    refreshVoiceEngineStatus(engine);
    if (typeof refreshVoiceTier4Visibility === 'function') refreshVoiceTier4Visibility(engine);
  } catch (e) {
    console.warn('[voice-engine] save failed:', e);
  }
}

function refreshVoiceEngineStatus(engine) {
  const badge = document.getElementById('voice-engine-status');
  const info = document.getElementById('voice-engine-active-info');
  if (!badge) return;
  const labels = {
    tier4: { name: 'Tier 4 Native (Kokoro ONNX)', detail: 'In-process, no Python. ~1.2s first audio on GPU (DirectML).' },
    python: { name: 'Python Sidecar', detail: 'Requires installed venv. Sub-tier (Lite/Pro/Studio) controlled by which sidecar port is running.' },
    cpu_fallback: { name: 'CPU Fallback (Sherpa+Matcha)', detail: 'Slow, lower quality. Use only if neither GPU nor Python sidecar are available.' },
  };
  const lbl = labels[engine] || { name: engine, detail: '' };
  badge.className = 'status-badge ok';
  badge.innerHTML = `<span class="status-dot"></span> Active: ${lbl.name}`;
  if (info) info.textContent = lbl.detail;
}

// ── Tier 4 advanced (voice / speed / device / dtype + whisper) ──
// Persists per-key to settings.json via /api/settings on every change.
// The voice-session reader picks up changes on the next session — no restart.
// Empty-string values delete the key (server merges naively, so we send null).
async function onTier4SettingChange(key, raw) {
  if (!key) return;
  let value = (raw === '' || raw == null) ? null : raw;
  if (key === 'voiceTier4Speed' && value != null) {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) {
      console.warn('[tier4-settings] speed out of range; ignoring');
      return;
    }
    value = n;
  }
  try {
    const payload = {}; payload[key] = value;
    if (typeof apiPost === 'function') await apiPost('/api/settings', payload);
    else await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    try {
      const saved = JSON.parse(localStorage.getItem('sax_settings') || '{}');
      if (value === null) delete saved[key]; else saved[key] = value;
      localStorage.setItem('sax_settings', JSON.stringify(saved));
    } catch {}
  } catch (e) {
    console.warn('[tier4-settings] save failed:', key, e);
  }
}
window.onTier4SettingChange = onTier4SettingChange;

function refreshVoiceTier4Visibility(engine) {
  const panel = document.getElementById('voice-tier4-options');
  if (!panel) return;
  panel.style.display = engine === 'tier4' ? '' : 'none';
}
window.refreshVoiceTier4Visibility = refreshVoiceTier4Visibility;

// Push-to-talk settings UI. Driven by window.PushToTalk (push-to-talk.js)
// which owns localStorage persistence; this section only renders the saved
// state and forwards user input back into PushToTalk.setMode/setChord.
function syncPttUiFromConfig() {
  if (!window.PushToTalk) return;
  const cfg = window.PushToTalk.getConfig();
  const modeSel = document.getElementById('cfg-ptt-mode');
  if (modeSel) modeSel.value = cfg.mode;
  const field = document.getElementById('ptt-chord-field');
  if (field) field.style.display = cfg.mode === 'off' ? 'none' : '';
  const display = document.getElementById('ptt-chord-display');
  if (display) display.textContent = window.PushToTalk.formatChord(cfg.chord);
}
function onPttModeChange(mode) {
  if (!window.PushToTalk) return;
  window.PushToTalk.setMode(mode);
  syncPttUiFromConfig();
}
async function onPttChordCapture() {
  if (!window.PushToTalk || !window.HotkeyCapture) return;
  const chord = await window.HotkeyCapture.open();
  if (!chord) return;
  window.PushToTalk.setChord(chord);
  syncPttUiFromConfig();
}
window.onPttModeChange = onPttModeChange;
window.onPttChordCapture = onPttChordCapture;
window.syncPttUiFromConfig = syncPttUiFromConfig;

let _tier4VoiceCatalog = null;
async function loadVoiceTier4Settings(s) {
  const select = document.getElementById('cfg-voice-tier4-voice');
  if (!_tier4VoiceCatalog) {
    try {
      const r = await (typeof apiFetch === 'function' ? apiFetch('/api/voice/tier4/voices') : fetch('/api/voice/tier4/voices'));
      _tier4VoiceCatalog = await r.json();
    } catch (e) {
      console.warn('[tier4-settings] /api/voice/tier4/voices failed', e);
      _tier4VoiceCatalog = { voices: [], default: 'am_michael' };
    }
  }
  if (select && _tier4VoiceCatalog && Array.isArray(_tier4VoiceCatalog.voices)) {
    const def = _tier4VoiceCatalog.default || 'am_michael';
    const list = _tier4VoiceCatalog.voices.slice().sort((a, b) => {
      const aEn = a.language && a.language.startsWith('en') ? 0 : 1;
      const bEn = b.language && b.language.startsWith('en') ? 0 : 1;
      return aEn - bEn || (a.id || '').localeCompare(b.id || '');
    });
    const optEsc = (str) => String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    select.innerHTML = '<option value="">Default (' + optEsc(def) + ')</option>' +
      list.map(v => '<option value="' + optEsc(v.id) + '">' + optEsc(v.name || v.id) + ' — ' + optEsc(v.language || '?') + '/' + optEsc(v.gender || '?') + '</option>').join('');
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); };
  set('cfg-voice-tier4-voice', s.voiceTier4Voice);
  set('cfg-voice-tier4-speed', s.voiceTier4Speed);
  set('cfg-voice-tier4-device', s.voiceTier4Device);
  set('cfg-voice-tier4-dtype', s.voiceTier4Dtype);
  set('cfg-voice-whisper-model', s.voiceWhisperModel);
  set('cfg-voice-whisper-device', s.voiceWhisperDevice);
}
window.loadVoiceTier4Settings = loadVoiceTier4Settings;

