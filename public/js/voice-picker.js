// Media tab voice picker (tier model). Catalog data lives in
// voice-picker-catalog.js — load that BEFORE this file.
//
// One dropdown picks a tier. Tier card below shows status pills + inline
// install/start buttons for missing prerequisites. Voice list filters to the
// tier's voicePool. The chat-bar voice selector reads getActiveVoiceTier()
// and voiceFitsTier() (both exposed on window) to mirror the same filter.

const C = window.LAX_VOICE_CATALOG;
let _kokoroCatalog = null;
let _setupStatus = null;          // last /api/voices/setup/status response
let _secretNames = null;          // last /api/secrets list (lowercased name set)
let _browserVoiceList = null;     // window.speechSynthesis.getVoices() snapshot

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function getTierById(id) {
  return C.TIERS.find(t => t.id === id) || null;
}
window.getTierById = getTierById;

function _resolveActiveTierId(saved) {
  if (saved?.voiceMode === 'realtime') return 'realtime';
  if (saved?.voiceMode === 'browser') return 'browser';
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
  // truth into sax_settings on each loadSettings.
  let s = {};
  try { s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); } catch {}
  return getTierById(_resolveActiveTierId(s)) || getTierById(C.DEFAULT_TIER_ID);
}
window.getActiveVoiceTier = getActiveVoiceTier;

function voiceFitsTier(voiceId, tier) {
  if (!voiceId || !tier) return false;
  const pool = tier.voicePool || [];
  if (pool.includes('clones') && (voiceId.startsWith('sv:') || voiceId.startsWith('cb:'))) return true;
  if (pool.includes('kokoro') && /^[abm]?[fmb]?_/.test(voiceId)) return true;
  if (pool.includes('edge') && /^en-[A-Z]{2}-.+Neural$/.test(voiceId)) return true;
  if (pool.includes('realtime') && C.REALTIME_VOICES.some(([id]) => id === voiceId)) return true;
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

function _checkPrereq(p) {
  // Returns { ok, hint, action }. action is one of: install-sidecar, start-sidecar, install-npm, set-secret, none.
  if (p.kind === 'browser-tts') {
    const ok = typeof window !== 'undefined' && 'speechSynthesis' in window;
    return { ok, hint: ok ? 'Available' : 'Browser does not expose SpeechSynthesis', action: 'none' };
  }
  if (p.kind.startsWith('sidecar:')) {
    const id = p.kind.slice('sidecar:'.length);
    const t = (_setupStatus?.tiers || []).find(x => x.id === id);
    if (!t) return { ok: false, hint: 'Probing…', action: 'none', tierId: id };
    if (t.healthy) return { ok: true, hint: 'Running', action: 'none', tierId: id };
    if (t.installed) return { ok: false, hint: 'Installed, not running', action: 'start-sidecar', tierId: id };
    // Studio-trained partial-state nuance: if the GPT-SoVITS repo + trained
    // weights are on disk but the venv is missing, surface that explicitly
    // so users with a wiped venv know their voices (Optimus etc.) survived
    // and they just need to click Install to rebuild the venv.
    if (id === 'studio-trained' && t.weightsPresent) {
      return { ok: false, hint: 'Weights found — click Install to rebuild venv', action: 'install-sidecar', tierId: id };
    }
    if (id === 'studio-trained' && t.repoPresent) {
      return { ok: false, hint: 'Repo present, no trained voices yet', action: 'install-sidecar', tierId: id };
    }
    return { ok: false, hint: 'Not installed', action: 'install-sidecar', tierId: id };
  }
  if (p.kind.startsWith('secret:')) {
    const name = p.kind.slice('secret:'.length).toUpperCase();
    if (!_secretNames) return { ok: false, hint: 'Probing…', action: 'none', secretName: name };
    const ok = _secretNames.has(name);
    return { ok, hint: ok ? 'Set' : 'Missing', action: ok ? 'none' : 'set-secret', secretName: name };
  }
  if (p.kind.startsWith('npm:')) {
    const pkg = p.kind.slice('npm:'.length);
    const tier4Native = (_setupStatus?.tiers || []).find(x => x.id === 'native');
    if (pkg === 'kokoro-js' || pkg === 'kokoro-js + onnxruntime-node') {
      const ok = !!(tier4Native && tier4Native.installed);
      const cached = !!(tier4Native?.healthPayload?.modelCached);
      return { ok: ok && cached, hint: !ok ? 'Run npm install' : (cached ? 'Ready' : 'Will download on first use'), action: 'none' };
    }
    // Real probe via /api/voices/setup/status `npm` block. Server checks
    // node_modules/<pkg>/package.json existence + parses version. The label
    // for this prereq is usually "msedge-tts npm package" — match by the
    // first whitespace-delimited token so future deps pick up automatically.
    const probed = _setupStatus?.npm || {};
    const pkgKey = pkg.split(/\s+/)[0];
    const info = probed[pkgKey];
    if (info === undefined) {
      // Probe hasn't returned yet, or this package isn't tracked server-side.
      return { ok: false, hint: 'Probing…', action: 'none' };
    }
    if (info.installed) {
      return { ok: true, hint: info.version ? `Installed v${info.version}` : 'Installed', action: 'none' };
    }
    return { ok: false, hint: 'Missing — run npm install', action: 'none' };
  }
  if (p.kind.startsWith('model:')) {
    const tier4Native = (_setupStatus?.tiers || []).find(x => x.id === 'native');
    const cached = !!(tier4Native?.healthPayload?.modelCached);
    return { ok: cached, hint: cached ? 'Cached' : 'Will download on first use', action: 'none' };
  }
  return { ok: true, hint: '', action: 'none' };
}

function _statusPill(text, kind) {
  const colors = { ok: 'var(--accent)', warn: '#dba917', err: 'var(--err,#c33)', muted: 'var(--muted)' };
  const c = colors[kind] || colors.muted;
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:.7rem"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c}"></span>${_esc(text)}</span>`;
}

function _renderPrereqRow(p, idx, tierId) {
  const r = _checkPrereq(p);
  let pill, action = '';
  if (r.ok) pill = _statusPill(r.hint, 'ok');
  else if (r.hint === 'Probing…') pill = _statusPill('Probing…', 'muted');
  else pill = _statusPill(r.hint, p.optional ? 'muted' : 'warn');

  const btnId = `prereq-btn-${tierId}-${idx}`;
  if (r.action === 'install-sidecar') {
    action = `<button class="action-btn primary" id="${btnId}" onclick="onTierPrereqAction('${tierId}','install-sidecar','${_esc(r.tierId)}',this)" style="font-size:.7rem;padding:4px 10px">Install</button>`;
  } else if (r.action === 'start-sidecar') {
    action = `<button class="action-btn primary" id="${btnId}" onclick="onTierPrereqAction('${tierId}','start-sidecar','${_esc(r.tierId)}',this)" style="font-size:.7rem;padding:4px 10px">Start</button>`;
  } else if (r.action === 'set-secret') {
    action = `<button class="action-btn" id="${btnId}" onclick="onTierPrereqAction('${tierId}','set-secret','${_esc(r.secretName)}',this)" style="font-size:.7rem;padding:4px 10px">Add ${_esc(r.secretName)}</button>`;
  }

  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--border)"><div style="font-size:.78rem">${_esc(p.label)}${p.optional ? ' <span style="color:var(--muted);font-size:.7rem">(optional)</span>' : ''}</div><div style="display:flex;align-items:center;gap:8px">${pill}${action}</div></div>`;
}

function _resolveSttProvider(tier) {
  if (!tier?.sttProviders?.length) return null;
  let picked = '';
  try {
    const s = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    picked = String(s.voiceSttProvider || '').toLowerCase();
  } catch {}
  const found = tier.sttProviders.find(p => p.id === picked);
  return found || tier.sttProviders[0];
}

function _renderSttProviderPicker(tier) {
  if (!tier?.sttProviders?.length) return '';
  const current = _resolveSttProvider(tier)?.id || tier.sttProviders[0].id;
  const opts = tier.sttProviders.map(p =>
    `<option value="${_esc(p.id)}"${p.id === current ? ' selected' : ''}>${_esc(p.label)}</option>`,
  ).join('');
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--border)">`
    + `<div style="font-size:.78rem">STT provider</div>`
    + `<select onchange="onSttProviderChange('${_esc(tier.id)}', this.value)" style="font-size:.75rem;padding:3px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px">${opts}</select>`
    + `</div>`;
}

async function onSttProviderChange(tierId, providerId) {
  const tier = getTierById(tierId);
  if (!tier?.sttProviders?.length) return;
  const provider = tier.sttProviders.find(p => p.id === providerId);
  if (!provider) return;
  await _persist({ voiceSttProvider: provider.id });
  try {
    const local = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    local.voiceSttProvider = provider.id;
    localStorage.setItem('sax_settings', JSON.stringify(local));
  } catch {}
  // Re-render so the dynamic secret prereq updates to match.
  await _refreshSecretNames();
  _renderTierStatus(tier);
}
window.onSttProviderChange = onSttProviderChange;

function _renderTierStatus(tier) {
  const wrap = document.getElementById('voice-tier-status');
  if (!wrap) return;
  // Build the effective prereqs list. For tiers with sttProviders we
  // synthesize a `secret:` prereq from the user's selected provider so the
  // same row can show "GROQ_API_KEY · Set" or "OPENAI_API_KEY · Missing"
  // depending on the dropdown above.
  const provider = _resolveSttProvider(tier);
  const effectivePrereqs = tier.prerequisites.slice();
  if (provider) {
    effectivePrereqs.push({
      kind: `secret:${provider.secret}`,
      label: `${provider.secret} (for STT)`,
    });
  }
  const required = effectivePrereqs.filter(p => !p.optional);
  const allOk = required.every(p => _checkPrereq(p).ok);
  const status = document.getElementById('voice-engine-status');
  if (status) {
    status.className = 'status-badge ' + (allOk ? 'ok' : 'warn');
    status.innerHTML = `<span class="status-dot"></span> ${allOk ? 'Ready: ' : 'Setup needed: '}${_esc(tier.label)}`;
  }
  const rows = effectivePrereqs.map((p, i) => _renderPrereqRow(p, i, tier.id)).join('');
  const sttPicker = _renderSttProviderPicker(tier);
  wrap.innerHTML = `<div style="margin-top:10px;padding:10px 12px;background:var(--surface);border-radius:8px;border:1px solid var(--border)"><div style="font-size:.74rem;color:var(--muted);margin-bottom:4px">${_esc(tier.detail)}</div>${rows}${sttPicker}</div>`;
}

function _kokoroOptions(current) {
  const voices = (_kokoroCatalog?.voices || []).slice().sort((a, b) => {
    const aEn = a.language?.startsWith('en') ? 0 : 1;
    const bEn = b.language?.startsWith('en') ? 0 : 1;
    return aEn - bEn || (a.id || '').localeCompare(b.id || '');
  });
  const groups = { 'American Male': [], 'American Female': [], 'British Male': [], 'British Female': [], 'Other': [] };
  for (const v of voices) {
    const id = v.id || '';
    if (id.startsWith('am_')) groups['American Male'].push(v);
    else if (id.startsWith('af_')) groups['American Female'].push(v);
    else if (id.startsWith('bm_')) groups['British Male'].push(v);
    else if (id.startsWith('bf_')) groups['British Female'].push(v);
    else groups['Other'].push(v);
  }
  const labelOf = (v) => v.name || (v.id?.split('_').slice(1).join('_').replace(/\b\w/g, c => c.toUpperCase())) || v.id;
  let html = '';
  for (const [g, list] of Object.entries(groups)) {
    if (!list.length) continue;
    html += `<optgroup label="${_esc(g)}">` +
      list.map(v => `<option value="${_esc(v.id)}"${v.id === current ? ' selected' : ''}>${_esc(labelOf(v))}</option>`).join('') +
      `</optgroup>`;
  }
  return html;
}

function _edgeOptions(current) {
  const compact = (v) => v.replace('Neural', '').replace('en-US-', '').replace('en-GB-', 'GB · ').replace('en-AU-', 'AU · ').replace('en-CA-', 'CA · ');
  return C.EDGE_VOICES.map(([g, list]) =>
    `<optgroup label="${_esc(g)}">` +
    list.map(v => `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(compact(v))}</option>`).join('') +
    `</optgroup>`,
  ).join('');
}

function _realtimeOptions(current) {
  return C.REALTIME_VOICES.map(([id, label]) =>
    `<option value="${_esc(id)}"${id === current ? ' selected' : ''}>${_esc(label)}</option>`,
  ).join('');
}

function _browserOptions(current) {
  let voices = [];
  try { voices = (window.speechSynthesis?.getVoices?.() || []).filter(v => v.lang?.startsWith('en')); } catch {}
  if (!voices.length) return `<option value="">(default browser voice)</option>`;
  return voices.map(v => `<option value="${_esc(v.name)}"${v.name === current ? ' selected' : ''}>${_esc(v.name)} — ${_esc(v.lang)}${v.default ? ' (default)' : ''}</option>`).join('');
}

function _studioOptions(current) {
  const sv = Array.isArray(window._sovitsVoices) ? window._sovitsVoices : [];
  const cb = Array.isArray(window._chatterboxVoices) ? window._chatterboxVoices : [];
  let html = `<optgroup label="Kokoro built-ins">${_kokoroOptions(current)}</optgroup>`;
  if (sv.length) {
    html += `<optgroup label="Trained voices (SoVITS)">` + sv.map(c => {
      const star = c.fine_tuned ? ' ★' : ''; const v = 'sv:' + c.id;
      return `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(c.name || c.id)}${star}</option>`;
    }).join('') + `</optgroup>`;
  }
  if (cb.length) {
    html += `<optgroup label="Zero-shot clones (Chatterbox)">` + cb.map(c => {
      const v = 'cb:' + c.id;
      return `<option value="${_esc(v)}"${v === current ? ' selected' : ''}>${_esc(c.name || c.id)}</option>`;
    }).join('') + `</optgroup>`;
  }
  return html;
}

function _voiceListForTier(tierId, current) {
  if (tierId === 'browser') return _browserOptions(current);
  if (tierId === 'edge') return _edgeOptions(current);
  if (tierId === 'realtime') return _realtimeOptions(current);
  if (tierId === 'studio') return _studioOptions(current);
  return _kokoroOptions(current);
}
window.voiceListForTier = _voiceListForTier;

function _resolveCurrentVoice(saved, tierId) {
  let lax = '';
  try { lax = localStorage.getItem('lax_voice') || ''; } catch {}
  const tier = getTierById(tierId);
  if (lax && tier && voiceFitsTier(lax, tier)) return lax;
  const v = saved?.voiceTier4Voice;
  if (v && tier && voiceFitsTier(v, tier)) return v;
  if (tierId === 'realtime') return saved?.voiceRealtimeVoice || 'alloy';
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
  tierSel.innerHTML = C.TIERS.map(t =>
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
  // Refresh sax_settings cache so getActiveVoiceTier() (chat-bar reader) sees the new tier.
  try {
    const local = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    Object.assign(local, tier.settings, { voiceTier4Voice: '', voiceRealtimeVoice: '', ttsVoice: '' });
    localStorage.setItem('sax_settings', JSON.stringify(local));
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
  if (tierId === 'kokoro' || tierId === 'studio') { try { localStorage.setItem('lax_voice', voice); } catch {} }
  // Browser tier reads the chosen voice synchronously from localStorage at
  // utterance-build time (chat.js _browserResolveVoice). Server settings are
  // persisted async via _persist() below — that round-trip is too slow for
  // streaming TTS, hence the dedicated key.
  if (tierId === 'browser') { try { localStorage.setItem('lax_browser_voice', voice); } catch {} }
  const payload = tierId === 'realtime' ? { voiceRealtimeVoice: voice } : { voiceTier4Voice: voice, ttsVoice: voice };
  await _persist(payload);
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

async function onTierPrereqAction(tierId, action, target, btn) {
  const tier = getTierById(tierId);
  if (!tier || !btn) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    if (action === 'install-sidecar') {
      btn.textContent = 'Installing… (5–15 min)';
      const d = await apiPost('/api/voices/setup/install', { tier: target });
      if (!d?.ok) {
        // Surface the actual installer output so users see the AV-exclusion
        // hint or whatever else install.ps1 emitted on failure. Generic
        // "exited with code 1" alerts are useless for non-tech users — the
        // installer's stdout has the recovery instructions.
        const tail = (d?.output || '').toString().slice(-1500);
        const isAvLikely = /Defender|antivirus|exclusions|verify|wheel/i.test(tail);
        const lead = d?.exitCode === 2
          ? 'Install verify failed (AV may have deleted a wheel mid-install).'
          : isAvLikely
          ? 'Installer reported a problem likely caused by antivirus.'
          : `Installer exited with code ${d?.exitCode ?? '?'}.`;
        const recovery = isAvLikely || d?.exitCode === 2
          ? '\n\nFix:\n  1. Open Windows Security → Virus & threat protection\n  2. Manage settings → Add or remove exclusions\n  3. Add: %USERPROFILE%\\.lax\n  4. Click Install again.'
          : '';
        alert(lead + recovery + (tail ? '\n\nLast output:\n' + tail : ''));
        throw new Error(lead);
      }
    } else if (action === 'start-sidecar') {
      btn.textContent = 'Starting…';
      const d = await apiPost('/api/voices/setup/start', { tier: target });
      if (!d?.ok && !d?.already) throw new Error(d?.error || 'sidecar did not start');
    } else if (action === 'set-secret') {
      // Defer to existing secrets UI rather than building an inline form.
      if (typeof openSecretsModal === 'function') openSecretsModal();
      else alert(`Add the secret named ${target} from the Security tab → Secrets, then return here.`);
    }
    await _refreshSetupStatus();
    await _refreshSecretNames();
    _renderTierStatus(tier);
  } catch (e) {
    btn.disabled = false; btn.textContent = orig;
    // Don't double-alert when we already surfaced a rich install message above.
    if (action !== 'install-sidecar') alert('Failed: ' + (e?.message || e));
  }
}
window.onTierPrereqAction = onTierPrereqAction;
