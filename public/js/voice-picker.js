// ── Media tab voice picker — core ──
// Catalog: voice-picker-catalog.js (must load BEFORE this).
// Prereq probe + tier status: voice-picker-prereqs.js.
// Voice-list option builders: voice-picker-options.js.
//
// Tier dropdown drives:
//   - Tier card below (status pills + install/start prereq buttons)
//   - The Voice dropdown (filtered to the tier's voicePool)
//   - The chat-bar voice selector via getActiveVoiceTier() + voiceFitsTier()
//     (both exposed on window so chat-status-bar.js mirrors the filter).

const C = window.LAX_VOICE_CATALOG;
// Browser tier relies on the Web Speech API key, which Electron-Chromium
// strips — so it's hidden from the picker in the desktop app (Edge is the
// zero-setup default there). Still offered in real browsers.
const IS_ELECTRON = /electron/i.test(navigator.userAgent || '');
let _kokoroCatalog = null;
let _setupStatus = null;          // last /api/voices/setup/status response
let _secretNames = null;          // last /api/secrets list (uppercased name set)
let _browserVoiceList = null;     // window.speechSynthesis.getVoices() snapshot

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function getTierById(id) {
  return C.TIERS.find(t => t.id === id) || null;
}
window.getTierById = getTierById;

function _resolveActiveTierId(saved) {
  // Existing users with the removed realtime tier (voiceMode='realtime', which
  // also set voiceEngine='tier4') fall through to the tier4/kokoro→studio
  // migration below — same pattern as the dropped Kokoro-local tier.
  if (saved?.voiceMode === 'browser') return IS_ELECTRON ? C.DEFAULT_TIER_ID : 'browser';
  if (saved?.voiceEngine === 'python') return 'studio';
  if (saved?.voiceTier4Provider === 'edge-tts') return 'edge';
  // The standalone Kokoro-local tier was removed from the picker. Existing
  // users with voiceTier4Provider='kokoro' get migrated to Studio (which
  // also ships Kokoro voices via the more robust Python Lite sidecar). The
  // kokoro-js adapter still works for env-var driven configs, but the
  // picker no longer surfaces it as a tier choice.
  if (saved?.voiceTier4Provider === 'kokoro' || saved?.voiceEngine === 'tier4') return 'studio';
  return C.DEFAULT_TIER_ID;
}

function getActiveVoiceTier() {
  // Used by the chat bar — reads localStorage cache so it doesn't need to
  // round-trip /api/settings on every render. settings.js mirrors server
  // truth into lax_settings on each loadSettings.
  let s = {};
  try { s = JSON.parse(localStorage.getItem('lax_settings') || '{}'); } catch {}
  return getTierById(_resolveActiveTierId(s)) || getTierById(C.DEFAULT_TIER_ID);
}
window.getActiveVoiceTier = getActiveVoiceTier;

function voiceFitsTier(voiceId, tier) {
  if (!voiceId || !tier) return false;
  const pool = tier.voicePool || [];
  if (pool.includes('clones') && (voiceId.startsWith('sv:') || voiceId.startsWith('cb:'))) return true;
  if (pool.includes('kokoro') && /^[abm]?[fmb]?_/.test(voiceId)) return true;
  if (pool.includes('edge') && /^en-[A-Z]{2}-.+Neural$/.test(voiceId)) return true;
  if (pool.includes('browser')) return true; // browser SR returns OS voices, can't validate
  return false;
}
window.voiceFitsTier = voiceFitsTier;

async function _loadKokoroCatalogOnce() {
  if (_kokoroCatalog) return _kokoroCatalog;
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/voice/tier4/voices') : fetch('/api/voice/tier4/voices'));
    _kokoroCatalog = await r.json();
  } catch { _kokoroCatalog = { voices: [], default: 'am_michael' }; }
  return _kokoroCatalog;
}

async function _refreshSetupStatus() {
  try {
    if (typeof apiJson === 'function') _setupStatus = await apiJson('/api/voices/setup/status');
    else { const r = await fetch('/api/voices/setup/status'); _setupStatus = await r.json(); }
  } catch { _setupStatus = { tiers: [] }; }
  return _setupStatus;
}

async function _refreshSecretNames() {
  try {
    const r = await (typeof apiFetch === 'function' ? apiFetch('/api/secrets') : fetch('/api/secrets'));
    const list = r.ok ? await r.json() : [];
    _secretNames = new Set((Array.isArray(list) ? list : []).map(s => (s.name || s).toString().toUpperCase()));
  } catch { _secretNames = new Set(); }
  return _secretNames;
}

function _resolveCurrentVoice(saved, tierId) {
  let lax = '';
  try { lax = localStorage.getItem('lax_voice') || ''; } catch {}
  const tier = getTierById(tierId);
  if (lax && tier && voiceFitsTier(lax, tier)) return lax;
  const v = saved?.voiceTier4Voice;
  if (v && tier && voiceFitsTier(v, tier)) return v;
  if (tierId === 'edge') return C.EDGE_VOICES[0][1][0];
  if (tierId === 'browser') return '';
  return _kokoroCatalog?.default || 'am_michael';
}

async function loadVoicePicker(saved) {
  const tierSel = document.getElementById('cfg-voice-tier');
  const voiceSel = document.getElementById('cfg-voice-voice');
  if (!tierSel || !voiceSel) return;

  await Promise.all([_loadKokoroCatalogOnce(), _refreshSetupStatus(), _refreshSecretNames()]);

  // Browser voice list populates async; subscribe to refresh once if empty.
  try {
    if (window.speechSynthesis && !window.speechSynthesis.getVoices().length) {
      window.speechSynthesis.onvoiceschanged = () => loadVoicePicker(saved);
    }
  } catch {}

  const tierId = _resolveActiveTierId(saved || {});
  const visibleTiers = C.TIERS.filter(t => !(IS_ELECTRON && t.id === 'browser'));
  tierSel.innerHTML = visibleTiers.map(t =>
    `<option value="${_esc(t.id)}"${t.id === tierId ? ' selected' : ''}>${_esc(t.label)} — ${_esc(t.tagline)}</option>`,
  ).join('');

  const tier = getTierById(tierId);
  _renderTierStatus(tier);
  const current = _resolveCurrentVoice(saved || {}, tierId);
  voiceSel.innerHTML = _voiceListForTier(tierId, current);

  const speedEl = document.getElementById('cfg-voice-speed');
  if (speedEl) {
    let s = '';
    try { s = localStorage.getItem('lax_speed') || ''; } catch {}
    if (!s && saved?.voiceTier4Speed != null) s = String(saved.voiceTier4Speed);
    speedEl.value = s || '';
    speedEl.placeholder = s || '1.15';
  }

  // The "in-process device" advanced panel was tied to the old standalone
  // Kokoro-local tier. With that tier dropped, no remaining tier exposes
  // those knobs — Studio's Python sidecar manages its own device internally,
  // Edge/cloud tiers don't run on a local device at all. Always hide.
  const advanced = document.getElementById('voice-tier4-options');
  if (advanced) advanced.style.display = 'none';
}
window.loadVoicePicker = loadVoicePicker;

async function _persist(payload) {
  try {
    if (typeof apiPost === 'function') await apiPost('/api/settings', payload);
    else await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { console.warn('[voice-picker] save failed:', e?.message || e); }
}

async function onTierChange(tierId) {
  const tier = getTierById(tierId);
  if (!tier) return;
  // Clear any previously-saved voice. Each tier expects a different voice-name
  // format (browser uses "Microsoft Zira - English (United States)", edge uses
  // "en-US-AriaNeural", kokoro uses "am_michael", etc.). Carrying a voice
  // across a tier switch sends a name the new adapter can't parse — edge-tts
  // crashes with "Could not infer voiceLocale", kokoro silently picks default,
  // etc. Wiping the keys forces each adapter to fall back to its own default.
  try {
    localStorage.removeItem('lax_voice');
    localStorage.removeItem('lax_browser_voice');
  } catch {}
  await _persist({ ...tier.settings, voiceTier4Voice: '', voiceRealtimeVoice: '', ttsVoice: '' });
  // Refresh lax_settings cache so getActiveVoiceTier() (chat-bar reader) sees the new tier.
  try {
    const local = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    Object.assign(local, tier.settings, { voiceTier4Voice: '', voiceRealtimeVoice: '', ttsVoice: '' });
    localStorage.setItem('lax_settings', JSON.stringify(local));
  } catch {}
  await loadVoicePicker({ ...tier.settings, voiceTier4Voice: '', voiceRealtimeVoice: '' });
  // Re-render the chat bar so its voice list re-filters.
  if (typeof updateStatusBar === 'function') updateStatusBar();
}
window.onTierChange = onTierChange;
window.switchVoiceTier = onTierChange;

async function onVoicePickChange(voice) {
  const tierId = document.getElementById('cfg-voice-tier')?.value || C.DEFAULT_TIER_ID;
  if (voice === '__train_voice__' || voice === '__add_chatterbox__' || voice === '__manage_clones__') {
    if (voice === '__train_voice__' && typeof openTrainVoiceModal === 'function') openTrainVoiceModal();
    else if (voice === '__add_chatterbox__' && typeof openAddChatterboxModal === 'function') openAddChatterboxModal();
    else if (voice === '__manage_clones__' && typeof openManageClonesModal === 'function') openManageClonesModal();
    let prev = ''; try { prev = localStorage.getItem('lax_voice') || ''; } catch {}
    const sel = document.getElementById('cfg-voice-voice'); if (sel && prev) sel.value = prev;
    return;
  }
  if (!voice) return;
  if (tierId === 'kokoro' || tierId === 'studio' || tierId === 'studio-trained') { try { localStorage.setItem('lax_voice', voice); } catch {} }
  // Browser tier reads the chosen voice synchronously from localStorage at
  // utterance-build time (chat.js _browserResolveVoice). Server settings are
  // persisted async via _persist() below — that round-trip is too slow for
  // streaming TTS, hence the dedicated key.
  if (tierId === 'browser') { try { localStorage.setItem('lax_browser_voice', voice); } catch {} }
  await _persist({ voiceTier4Voice: voice, ttsVoice: voice });
  try {
    if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === 1) {
      const speed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
      voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed }));
    }
  } catch {}
  if (typeof updateStatusBar === 'function') updateStatusBar();
}
window.onVoicePickChange = onVoicePickChange;

function onVoiceSpeedChange(raw) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 2) return;
  try { localStorage.setItem('lax_speed', String(n)); } catch {}
  void _persist({ voiceTier4Speed: n });
  try {
    if (typeof voiceWS !== 'undefined' && voiceWS && voiceWS.readyState === 1) {
      const voice = localStorage.getItem('lax_voice') || 'am_michael';
      voiceWS.send(JSON.stringify({ type: 'voice_settings', voice, speed: n }));
    }
  } catch {}
}
window.onVoiceSpeedChange = onVoiceSpeedChange;
