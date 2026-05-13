// ── Chat: Status Bar + Context Bar ──
//
// Bottom-of-chat status bar (provider/model/voice/speed pickers, context
// usage indicator, training pill). Polls the server for provider list,
// reflects voice-tier changes, classifies model strength so weak models
// surface a warning chip. Extracted from chat.js as part of the 400-LOC
// god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc                      (shared.js)
//   - getActiveVoiceTier, voiceFitsTier, (voice-picker.js / voice-picker-catalog.js)
//     voiceListForTier
//   - LAX_VOICE_CATALOG                  (voice-picker-catalog.js)
//   - lastContextStatus                  (window — read by updateStatusBar)
//   - openTrainVoiceModal, openAddChatterboxModal, openManageClonesModal
//                                        (chat-voice-modals.js — referenced via
//                                         onclick attributes / pollTrainingStatus)

// ── Context usage indicator ──
//
// Two places read the latest status:
//   - this file's `updateContextBar` (the progress bar above the composer)
//   - `updateStatusBar` further down (the ✏️ token chip in the bottom bar)
//
// They MUST read the same source of truth. Until this fix they didn't:
// updateContextBar mutated a module-local `lastContextStatus`, while the
// status-bar chip read `window.lastContextStatus` (initialized null in
// chat-uploads.js and never written). Result: the bar was driven only by
// transient updates and the chip was always blank/zero. Mirror to window
// so both paths see fresh data.
function updateContextBar(event) {
  if (event) window.lastContextStatus = event;
  const data = window.lastContextStatus;

  let bar = document.getElementById('context-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'context-bar';
    bar.style.cssText = 'display:none;max-width:800px;margin:0 auto 8px;width:100%;padding:0 14px';
    const inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.insertBefore(bar, inputArea.firstChild);
  }

  // No data yet → hide the bar instead of showing a fake "0K / 128K" reading
  // that users (correctly) interpret as "context is empty." A blank bar is
  // honest about "no measurement yet"; a zeroed bar lies.
  if (!data) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';

  // Color based on level
  let color = 'var(--accent)';      // green
  if (data.percentage >= 95) color = 'var(--danger)';
  else if (data.percentage >= 85) color = 'var(--warn)';
  else if (data.percentage >= 70) color = '#88aaff';

  const compactedNote = data.compacted ? ' <span style="color:var(--accent)">(compacted)</span>' : '';
  const tokensK = (data.usedTokens / 1000).toFixed(0);
  const maxK = (data.maxTokens / 1000).toFixed(0);

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:.68rem">
      <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${Math.min(data.percentage, 100)}%;background:${color};border-radius:2px;transition:width .3s"></div>
      </div>
      <span style="color:${color};white-space:nowrap">${data.percentage}% context${compactedNote}</span>
      <span style="color:var(--muted);white-space:nowrap">${tokensK}K / ${maxK}K</span>
    </div>
  `;
}

// ── Status bar (feature 97) ──
let serverStartTime = Date.now();

let _providersCache = null;
let _providersCacheTime = 0;

async function _primeSaxSettings() {
  try {
    const r = await apiFetch('/api/settings');
    if (!r || !r.ok) return;
    const server = await r.json();
    if (!server || typeof server !== 'object') return;
    const local = JSON.parse(localStorage.getItem('sax_settings') || '{}');
    // Server is source of truth for tier-defining keys — overwrite local
    // copies that might be stale from a previous session. We don't replace
    // the entire blob because settings.js stores some client-only keys
    // (lax_*) under sax_settings too on some flows.
    const tierKeys = ['voiceMode', 'voiceEngine', 'voiceTier4Provider', 'voiceTier4Voice', 'voiceSttProvider', 'voiceRealtimeVoice', 'ttsVoice'];
    for (const k of tierKeys) if (k in server) local[k] = server[k];
    localStorage.setItem('sax_settings', JSON.stringify(local));
  } catch {}
}

function initStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  // Prime sax_settings from the server before the chat-bar renders. Without
  // this, getActiveVoiceTier() reads stale localStorage and shows browser-
  // tier voices in the picker even when settings.json on disk says tier 2.
  // Settings page also writes sax_settings, but the chat page is the entry
  // point users hit first — we can't assume settings.js has run this session.
  _primeSaxSettings().then(() => loadProviders()).then(() => updateStatusBar());
  setInterval(updateStatusBar, 10000);
  apiFetch('/api/auth/status').then(r => r.json()).then(d => {
    if (d.uptime) serverStartTime = Date.now() - (d.uptime * 1000);
  }).catch(() => {});
  // Studio tier detection: only fetch the cloned-voice library if the
  // Chatterbox sidecar is up. Re-renders the picker once we know.
  refreshClonedVoices();
  // Persistent training-status pill: polls /api/voices/sovits/training/list
  // every 30s. Shows a small indicator near the top of the chat when a
  // pipeline is running so the user knows training is still alive after
  // they navigate away and come back. Auto-hides + refreshes the voice
  // picker when training completes.
  // 10s poll instead of 30s so newly-registered clones (or stalled
  // orchestrators that the user manually nudged) appear in the picker
  // within ~10s, no server restart needed.
  pollTrainingStatus();
  setInterval(pollTrainingStatus, 10000);
}

let _lastTrainingRunCount = 0;
async function pollTrainingStatus() {
  let runs = [];
  try {
    const r = await apiFetch('/api/voices/sovits/training/list');
    if (r.ok) {
      const d = await r.json();
      runs = (d.runs || []).filter(x => x.stage !== 'register');
    }
  } catch { return; }
  // Always refresh the clone list — cheap call (one /tier probe + at most
  // two list calls), and it covers cases the running→idle transition
  // misses (orchestrator died before registering, user added a clone via
  // the manage modal, manual API registration, etc.).
  refreshClonedVoices().then(() => updateStatusBar?.());
  _lastTrainingRunCount = runs.length;

  let pill = document.getElementById('training-pill');
  if (runs.length === 0) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'training-pill';
    pill.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;padding:6px 14px;border:1px solid #4a9eff;background:rgba(8,18,38,.9);color:#9fdcff;border-radius:18px;font-size:.78rem;font-family:var(--mono,monospace);cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 2px 12px rgba(74,158,255,.3)';
    pill.title = 'Click to open training panel';
    pill.addEventListener('click', () => { if (typeof openTrainVoiceModal === 'function') openTrainVoiceModal(); });
    document.body.appendChild(pill);
  }
  const stageLabels = {
    download: 'downloading', slice: 'slicing', asr: 'transcribing',
    ref: 'picking ref', format: 'extracting features',
    train_sovits: 'training SoVITS', train_gpt: 'training GPT',
  };
  const r0 = runs[0];
  const stage = stageLabels[r0.stage] || r0.stage;
  const more = runs.length > 1 ? ` +${runs.length - 1} more` : '';
  pill.textContent = `🎤 Training ${r0.name} · ${stage}${more}`;
}

async function refreshClonedVoices() {
  try {
    const tierRes = await apiFetch('/api/voices/tier');
    const tier = await tierRes.json();
    window._studioTierReady = !!(tier.chatterbox && tier.chatterbox.ready);
    window._sovitsTierReady = !!(tier.sovits && tier.sovits.ready);
    // SoVITS clones (trained or zero-shot) — best quality when fine-tuned
    if (window._sovitsTierReady) {
      const r = await apiFetch('/api/voices/sovits');
      if (r.ok) {
        const data = await r.json();
        window._sovitsVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._sovitsVoices = [];
    }
    // Chatterbox clones (single-stage zero-shot TTS, fallback / parallel)
    if (window._studioTierReady) {
      const r = await apiFetch('/api/voices/chatterbox');
      if (r.ok) {
        const data = await r.json();
        window._chatterboxVoices = Array.isArray(data?.clones) ? data.clones : [];
      }
    } else {
      window._chatterboxVoices = [];
    }
    if (typeof updateStatusBar === 'function') updateStatusBar();
  } catch (e) {
    console.warn('[voice] tier/clones probe failed:', e.message);
  }
}

async function loadProviders() {
  if (_providersCache && Date.now() - _providersCacheTime < 30000) return _providersCache;
  try {
    const res = await apiFetch('/api/providers');
    const data = await res.json();
    _providersCache = data;
    _providersCacheTime = Date.now();
    return data;
  } catch { return null; }
}

// Mirrors server-side classifyModel() in src/model-tiers.ts. Keep in sync.
function classifyModelTier(model) {
  const m = String(model || '').toLowerCase();
  if (/:([1-9]b|1[0-3]b)(\b|-|$)/.test(m)) return 'weak';
  if (/\bqwen2?:7b\b/.test(m)) return 'weak';
  if (/^grok-3-mini$/.test(m)) return 'weak';
  if (/gpt-4o-mini|gpt-3\.5/.test(m)) return 'weak';
  if (/gemini-(1|2\.0)-flash/.test(m)) return 'weak';
  if (/haiku(?!-4-5)/.test(m)) return 'weak';
  if (/gpt-5(\.\d+)?($|-(?!mini))/.test(m)) return 'strong';
  if (/claude-opus-4|claude-sonnet-4-[6-9]|claude-haiku-4-5/.test(m)) return 'strong';
  if (/^o[34]($|-|\.)/.test(m)) return 'strong';
  if (/gemini-(2\.5|3)/.test(m)) return 'strong';
  // grok-4 intentionally medium — thinner tool-use RLHF than OpenAI/Anthropic
  return 'medium';
}

function updateStatusBar() {
  const bar = document.getElementById('status-bar-dynamic');
  if (!bar) return;
  // Skip re-render while the user is actively interacting with one of the
  // bar's controls. The bar is rebuilt via innerHTML below — clobbering it
  // while a <select> dropdown is open destroys the element and slams the
  // dropdown shut, which is the "picker closes if I'm not fast enough" bug.
  // <select> doesn't expose its open state, but Chrome/Edge/Firefox hold
  // focus on a select whose dropdown is open, so activeElement is a
  // reliable proxy. Same applies to the speed slider mid-drag. The 10s
  // cadence is for eventual freshness — skipping a tick is harmless.
  const ae = document.activeElement;
  if (ae && bar.contains(ae)) {
    const tag = ae.tagName;
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'OPTION') return;
  }
  const tokenInfo = window.lastContextStatus ? `${(window.lastContextStatus.usedTokens / 1000).toFixed(0)}K tokens` : '';
  const data = _providersCache;
  const currentProvider = data?.current?.provider || '—';
  const currentModel = data?.current?.model || '—';
  const providers = data?.providers || [];
  const activeP = providers.find(p => p.active) || providers[0];

  // Build provider dropdown options
  const providerOpts = providers.map(p =>
    `<option value="${esc(p.id)}" ${p.active ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');

  // Build model dropdown for active provider. Flag each option's tier so
  // weak models are obvious at selection time ("qwen2:7b · weak").
  const modelOpts = activeP ? activeP.models.map(m => {
    const tier = classifyModelTier(m);
    const tag = tier === 'weak' ? ' · weak' : tier === 'medium' ? ' · medium' : '';
    return `<option value="${esc(m)}" ${m === currentModel ? 'selected' : ''}>${esc(m)}${tag}</option>`;
  }).join('') : `<option value="${esc(currentModel)}">${esc(currentModel)}</option>`;

  // Active-model badge: warn when selection is weak.
  const tier = classifyModelTier(currentModel);
  const tierBadge = tier === 'weak'
    ? `<span class="status-item" style="background:#fef3c7;color:#92400e;border:1px solid #fbbf24;padding:2px 8px;border-radius:10px" title="This model may fail on agent tasks (tool calling, multi-step workflows). Switch to a stronger model for complex work.">&#9888; weak model — chat-only recommended</span>`
    : tier === 'medium'
    ? `<span class="status-item" style="opacity:.7" title="Medium-tier model. Agent tasks work but may be less reliable than flagship models.">&#9888; medium</span>`
    : '';

  // Voice picker + speed slider. Selection persists to localStorage and
  // is pushed to the server-side voice session over /ws/voice the moment
  // it changes (or on next session start). Built-in Kokoro voices are
  // always available; custom voice cloning is the optional Studio tier
  // (Chatterbox sidecar at :7010, populated when reachable).
  const savedVoice = localStorage.getItem('lax_voice') || 'am_michael';
  const savedSpeed = parseFloat(localStorage.getItem('lax_speed') || '1.15');
  // Voice list filters by the active voice tier (Browser / Edge cloud /
  // Kokoro local / Studio local / Realtime). The picker renderer lives in
  // /js/voice-picker.js — chat-bar just calls into it for consistency.
  let activeTier = null;
  try { activeTier = (typeof getActiveVoiceTier === 'function') ? getActiveVoiceTier() : null; } catch {}
  // Drop a saved voice that no longer fits the current tier (e.g. user was
  // on Studio with Optimus selected, switched to Browser — clear it).
  let effectiveVoice = savedVoice;
  if (activeTier && typeof voiceFitsTier === 'function' && !voiceFitsTier(savedVoice, activeTier)) {
    effectiveVoice = '';
  }
  let voiceOpts;
  if (activeTier && typeof voiceListForTier === 'function') {
    voiceOpts = voiceListForTier(activeTier.id, effectiveVoice);
    // Tier-aware quick actions: only relevant when the active tier supports clones.
    if ((activeTier.voicePool || []).includes('clones')) {
      voiceOpts += `<optgroup label=" ">`;
      if (window._sovitsTierReady) voiceOpts += `<option value="__train_voice__">+ Train a new voice (30 min)…</option>`;
      if (window._studioTierReady) voiceOpts += `<option value="__add_chatterbox__">+ Add a quick zero-shot voice…</option>`;
      if ((window._sovitsVoices?.length || window._chatterboxVoices?.length)) {
        voiceOpts += `<option value="__manage_clones__">&#9881; Manage cloned voices…</option>`;
      }
      voiceOpts += `</optgroup>`;
    }
  } else {
    // Fallback if voice-picker.js hasn't loaded yet — minimal Kokoro list.
    const fallback = [
      ['American Male', ['am_michael','am_adam','am_eric']],
      ['American Female', ['af_nicole','af_bella','af_sarah']],
    ];
    voiceOpts = fallback.map(([g, ids]) =>
      `<optgroup label="${esc(g)}">` +
      ids.map(id => `<option value="${esc(id)}" ${id === effectiveVoice ? 'selected' : ''}>${esc(id.split('_')[1])}</option>`).join('') +
      `</optgroup>`,
    ).join('');
  }
  // Tier switcher at the bottom of the dropdown — pick a different voice
  // system without leaving chat. Sentinels are __tier:<id>; quickSwitchVoice
  // routes them to switchVoiceTier().
  if (window.LAX_VOICE_CATALOG && Array.isArray(window.LAX_VOICE_CATALOG.TIERS)) {
    voiceOpts += `<optgroup label=" Switch system">`;
    for (const t of window.LAX_VOICE_CATALOG.TIERS) {
      if (activeTier && t.id === activeTier.id) continue;
      voiceOpts += `<option value="__tier:${esc(t.id)}">→ ${esc(t.label)}</option>`;
    }
    voiceOpts += `</optgroup>`;
  }

  // Project selector — drives the active chat's projectId. Left of the
  // provider picker because "what scope am I in" is the most upstream
  // decision (it gates which agents Primal can spawn). Reads the live
  // window.projects list (populated by app.js from /api/projects).
  const liveProjects = Array.isArray(window.projects) ? window.projects : [];
  const activeProjectId = (window.activeChat && window.activeChat.projectId) || '';
  let projectOpts = `<option value="">No project</option>`;
  for (const p of liveProjects) {
    const sel = p.id === activeProjectId ? ' selected' : '';
    projectOpts += `<option value="${esc(p.id)}"${sel}>${esc(p.name)}</option>`;
  }

  bar.innerHTML = `
    <select id="project-quick-select" class="status-select" onchange="quickSwitchProject(this.value)" title="Project scope for this chat — controls which agents Primal can spawn">${projectOpts}</select>
    <span style="color:var(--border)">|</span>
    <select id="provider-quick-select" class="status-select" onchange="quickSwitchProvider(this.value)" title="Switch provider">${providerOpts}</select>
    <span style="color:var(--border)">&#9654;</span>
    <select id="model-quick-select" class="status-select" onchange="quickSwitchModel(this.value)" title="Switch model">${modelOpts}</select>
    <span style="color:var(--border)">|</span>
    <select id="voice-quick-select" class="status-select" onchange="quickSwitchVoice(this.value)" title="Voice for spoken replies">${voiceOpts}</select>
    <input id="voice-speed-slider" type="range" min="0.7" max="1.5" step="0.05" value="${savedSpeed}" onchange="quickSwitchSpeed(this.value)" oninput="document.getElementById('voice-speed-label').textContent = parseFloat(this.value).toFixed(2)+'x'" title="Speech speed" style="width:80px;vertical-align:middle"/>
    <span id="voice-speed-label" class="status-item" style="font-family:var(--mono);min-width:42px">${savedSpeed.toFixed(2)}x</span>
    ${tierBadge}
    ${tokenInfo ? `<span class="status-item"><span class="status-icon">&#9998;</span> ${tokenInfo}</span>` : ''}
    <span class="status-item" title="All data stays on your machine. API calls go to your selected provider." style="cursor:help"><span class="status-icon">&#128274;</span> Local</span>
  `;
}


async function quickSwitchProject(projectId) {
  // Persist the project assignment on the active chat. The chat-send
  // path picks up streamChat.projectId on the next message, so the
  // selection takes effect from the user's next turn forward.
  if (!window.activeChat) return;
  if (projectId) window.activeChat.projectId = projectId;
  else delete window.activeChat.projectId;
  window.activeChat.updatedAt = Date.now();
  try { if (typeof window.saveChats === 'function') window.saveChats(); } catch {}
  try { if (typeof window.renderSidebar === 'function') window.renderSidebar(); } catch {}
}

async function quickSwitchProvider(providerId) {
  const data = _providersCache;
  const provider = data?.providers?.find(p => p.id === providerId);
  const model = provider ? provider.models[0] : '';
  try {
    await apiFetch('/api/providers/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, model }),
    });
    // Update local settings cache too
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); s.provider = providerId; s.model = model; localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0; // Force refresh
    await loadProviders();
    updateStatusBar();
  } catch (e) { console.warn('[provider] Switch failed:', e); }
}

async function quickSwitchModel(model) {
  const providerSel = document.getElementById('provider-quick-select');
  const provider = providerSel ? providerSel.value : '';
  try {
    await apiFetch('/api/providers/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    try { const s = JSON.parse(localStorage.getItem('sax_settings') || '{}'); s.model = model; localStorage.setItem('sax_settings', JSON.stringify(s)); } catch {}
    _providersCacheTime = 0;
    await loadProviders();
    updateStatusBar();
  } catch (e) { console.warn('[model] Switch failed:', e); }
}
