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

// ── Status bar (feature 97) ──
let serverStartTime = Date.now();

// Thinking-effort catalogue, shared with the cascade menu's flyout
// (chat-composer-menus.js). Order = menu order.
const LAX_EFFORT_LEVELS = [['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Max']];

function laxGetSavedEffort() {
  try { return JSON.parse(localStorage.getItem('lax_settings') || '{}').reasoningEffort || 'medium'; } catch { return 'medium'; }
}

let _providersCache = null;
let _providersCacheTime = 0;

async function _primeLaxSettings() {
  try {
    const r = await apiFetch('/api/settings');
    if (!r || !r.ok) return;
    const server = await r.json();
    if (!server || typeof server !== 'object') return;
    const local = JSON.parse(localStorage.getItem('lax_settings') || '{}');
    // Server is source of truth for tier-defining keys — overwrite local
    // copies that might be stale from a previous session. We don't replace
    // the entire blob because settings.js stores some client-only keys
    // (lax_*) under lax_settings too on some flows.
    const tierKeys = ['voiceMode', 'voiceEngine', 'voiceTier4Provider', 'voiceTier4Voice', 'voiceSttProvider', 'voiceRealtimeVoice', 'ttsVoice', 'reasoningEffort'];
    for (const k of tierKeys) if (k in server) local[k] = server[k];
    localStorage.setItem('lax_settings', JSON.stringify(local));
  } catch {}
}

function initStatusBar() {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  // Prime lax_settings from the server before the chat-bar renders. Without
  // this, getActiveVoiceTier() reads stale localStorage and shows browser-
  // tier voices in the picker even when settings.json on disk says tier 2.
  // Settings page also writes lax_settings, but the chat page is the entry
  // point users hit first — we can't assume settings.js has run this session.
  _primeLaxSettings().then(() => ensureProvidersLoaded());
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

// A providers payload is "complete" once the active provider has a model
// list. On a cold boot /api/providers returns instantly but with the Ollama
// model cache still warming server-side, so the active provider's models come
// back empty — the source of the empty picker boxes. Static-model providers
// (xAI, Anthropic, etc.) are complete on the first hit since their models come
// from the registry, not the warming cache.
function isProvidersComplete(data) {
  if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return false;
  if (!data.current || !data.current.provider) return false;
  const active = data.providers.find(p => p.active) || data.providers[0];
  return !!active && Array.isArray(active.models) && active.models.length > 0;
}

async function loadProviders() {
  if (_providersCache && Date.now() - _providersCacheTime < 30000) return _providersCache;
  try {
    const res = await apiFetch('/api/providers');
    const data = await res.json();
    _providersCache = data;
    // Only an incomplete result is left non-fresh (time 0) so the next call
    // refetches — a complete one is held for the 30s TTL. This is what stops
    // the boxes rendering empty for the whole warm-up window on cold boot.
    _providersCacheTime = isProvidersComplete(data) ? Date.now() : 0;
    return data;
  } catch { return null; }
}

// Force the bottom status-bar pickers to re-read /api/providers right now and
// re-render. Call this after ANY provider is connected/disconnected (OAuth
// sign-in, key save, etc.) so a newly added provider shows up immediately
// instead of only after a page refresh. Bypasses the 30s loadProviders cache.
async function refreshProviderPicker() {
  _providersCache = null;
  _providersCacheTime = 0;
  try { await loadProviders(); } catch {}
  try { updateStatusBar(true); } catch {}
}
window.refreshProviderPicker = refreshProviderPicker;

// Render whatever the first hit returns, then keep refetching until the
// server's provider caches warm (or we hit the ceiling). Without this the
// picker boxes sat empty until a manual provider switch, since updateStatusBar
// only re-renders the cache and never refetches.
async function ensureProvidersLoaded() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const data = await loadProviders();
    updateStatusBar();
    if (isProvidersComplete(data)) return;
    await new Promise(r => setTimeout(r, 1200));
  }
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
  // grok-4.x (4.5/4.3/4.20): full catalog. Earlier this was forced to medium on a
  // thin-tool-use-RLHF theory; the tighter cap made it worse (cut real tool calls),
  // so model-tiers.ts flipped it to strong. Keep in sync with that.
  if (/^grok-4(\b|-|$)/.test(m)) return 'strong';
  return 'medium';
}

function updateStatusBar(force) {
  const chips = document.getElementById('composer-chips');
  const info = document.getElementById('status-bar-dynamic');
  const voicePop = document.getElementById('voice-pop');
  if (!chips && !info) return;
  // Skip re-render while the user is actively interacting with one of the
  // controls. Everything is rebuilt via innerHTML below — clobbering a
  // <select> while its dropdown is open destroys the element and slams the
  // dropdown shut, which is the "picker closes if I'm not fast enough" bug.
  // <select> doesn't expose its open state, but Chrome/Edge/Firefox hold
  // focus on a select whose dropdown is open, so activeElement is a
  // reliable proxy. Same applies to the speed slider mid-drag. The 10s
  // cadence is for eventual freshness — skipping a tick is harmless.
  // The cascading model menu (chat-composer-menus.js) sets
  // window._laxModelMenuOpen while open; it renders from _providersCache
  // itself, so skipping the chip rebuild under it loses nothing.
  //
  // `force` overrides the guard for user-initiated re-renders. After the
  // user picks an option, a <select> retains focus even though its
  // dropdown is closed, so the periodic-tick guard would otherwise eat
  // the rebuild that laxSwitchModel actually needs.
  if (!force) {
    if (window._laxModelMenuOpen) return;
    const ae = document.activeElement;
    for (const host of [chips, voicePop]) {
      if (host && ae && host.contains(ae)) {
        const tag = ae.tagName;
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'OPTION') return;
      }
    }
  }
  const tokenInfo = window.lastContextStatus ? `${(window.lastContextStatus.usedTokens / 1000).toFixed(0)}K tokens` : '';
  const data = _providersCache;
  const currentProvider = data?.current?.provider || '—';
  const currentModel = data?.current?.model || '—';
  const providers = data?.providers || [];
  const activeP = providers.find(p => p.active) || providers[0];

  // Active-model badge: warn when selection is weak.
  const tier = classifyModelTier(currentModel);
  const tierBadge = tier === 'weak'
    ? `<span class="status-item" style="background:#fef3c7;color:#92400e;border:1px solid #fbbf24;padding:2px 8px;border-radius:10px" title="This model may fail on agent tasks (tool calling, multi-step workflows). Switch to a stronger model for complex work.">&#9888; weak model — chat-only recommended</span>`
    : tier === 'medium'
    ? `<span class="status-item" style="opacity:.7" title="Medium-tier model. Agent tasks work but may be less reliable than flagship models.">&#9888; medium</span>`
    : '';

  // Thinking effort. One global setting (settings.reasoningEffort),
  // applied to reasoning-capable models: Codex Responses API gets it verbatim
  // (Max = xhigh), OpenAI-compat providers get reasoning_effort (Max clamps
  // to high). Non-reasoning models ignore it. Server settings.json is the
  // source of truth — primed into lax_settings by _primeLaxSettings.
  // Rendered as part of the model chip; changed via the cascade menu's
  // per-model effort flyout (chat-composer-menus.js).
  const savedEffort = laxGetSavedEffort();
  const effortShort = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'Max' }[savedEffort] || savedEffort;

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
  // decision (it gates which agents this chat can spawn). Reads the live
  // window.projects list (populated by app.js from /api/projects).
  const liveProjects = Array.isArray(window.projects) ? window.projects : [];
  const activeProjectId = (window.activeChat && window.activeChat.projectId) || '';
  let projectOpts = `<option value="">No project</option>`;
  for (const p of liveProjects) {
    const sel = p.id === activeProjectId ? ' selected' : '';
    projectOpts += `<option value="${esc(p.id)}"${sel}>${esc(p.name)}</option>`;
  }

  // Enforced plan mode chip — session-scoped, server is source of truth
  // (mirrored into window._laxPlanMode by chat-ws-handler). While on, the
  // agent can research and propose but every file mutation is hard-blocked
  // until the user clicks the chip again (the approval event).
  const planReady = !!window.activeChat;
  const planOn = !!(planReady && window._laxPlanMode && window._laxPlanMode[window.activeChat.id]);
  const planTitle = !planReady
    ? 'Open a chat first — plan mode is set per conversation.'
    : planOn
      ? 'Plan mode is ON — the agent cannot change files. Click to approve changes and turn it off.'
      : 'Turn on plan mode — the agent researches and proposes, but cannot change files until you approve.';
  // Fixed footprint in BOTH states — the label never changes, only the color,
  // so toggling can't reflow the status bar or shrink the chat area.
  const planChip = `<button id="plan-mode-chip" onclick="togglePlanMode()" ${planReady ? '' : 'disabled'} title="${planTitle}"
    style="cursor:${planReady ? 'pointer' : 'not-allowed'};opacity:${planReady ? '1' : '.45'};white-space:nowrap;line-height:1;font-family:var(--mono);font-size:.68rem;padding:2px 10px;border-radius:10px;border:1px solid ${planOn ? 'var(--warn,#fbbf24)' : 'var(--border)'};background:${planOn ? 'rgba(251,191,36,.15)' : 'transparent'};color:${planOn ? 'var(--warn,#fbbf24)' : 'var(--muted)'};font-weight:${planOn ? '700' : '400'}">Plan</button>`;

  // One compact chip carries provider · model · thinking depth; clicking it
  // opens the cascading menu (providers → models → effort flyout).
  const providerName = activeP ? activeP.name : currentProvider;
  const modelChip = `<button id="model-chip" class="model-chip" onclick="toggleModelMenu(event)" aria-haspopup="true"
    title="Provider &#183; model &#183; thinking depth — click to change. Hover a model in the menu to set thinking depth.">
    <span>${esc(providerName)}</span><span class="mc-caret">&#9654;</span><span class="mc-model">${esc(currentModel)}</span><span class="mc-caret">&#183;</span><span>Think&nbsp;${esc(effortShort)}</span>
  </button>`;

  if (chips) chips.innerHTML = `
    ${planChip}
    <select id="project-quick-select" class="status-select" onchange="quickSwitchProject(this.value)" title="Project scope for this chat — controls which agents this chat can spawn">${projectOpts}</select>
    ${modelChip}
  `;

  if (info) info.innerHTML = `
    ${tierBadge}
    ${tokenInfo ? `<span class="status-item"><span class="status-icon">&#9998;</span> ${tokenInfo}</span>` : ''}
    <span class="status-item" title="All data stays on your machine. API calls go to your selected provider." style="cursor:help"><span class="status-icon">&#128274;</span> Local</span>
  `;

  // Voice + speed live in the speaker-icon popover. Only rebuild while it's
  // CLOSED — an open popover is being interacted with, and toggleVoicePop
  // triggers a fresh render right before showing it, so it never opens stale.
  if (voicePop && voicePop.style.display === 'none') voicePop.innerHTML = `
    <div class="vp-row"><span class="vp-label">VOICE</span>
      <select id="voice-quick-select" class="status-select" onchange="quickSwitchVoice(this.value)" title="Voice for spoken replies">${voiceOpts}</select></div>
    <div class="vp-row"><span class="vp-label">SPEED</span>
      <input id="voice-speed-slider" type="range" min="0.7" max="1.5" step="0.05" value="${savedSpeed}" onchange="quickSwitchSpeed(this.value)" oninput="document.getElementById('voice-speed-label').textContent = parseFloat(this.value).toFixed(2)+'x'" title="Speech speed"/>
      <span id="voice-speed-label" class="status-item" style="font-family:var(--mono);min-width:42px">${savedSpeed.toFixed(2)}x</span></div>
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

async function quickSwitchEffort(effort) {
  try {
    await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: effort }),
    });
    try { const s = JSON.parse(localStorage.getItem('lax_settings') || '{}'); s.reasoningEffort = effort; localStorage.setItem('lax_settings', JSON.stringify(s)); } catch {}
    updateStatusBar(true);
  } catch (e) { console.warn('[effort] Switch failed:', e); }
}

// Single switch path for the cascade menu (chat-composer-menus.js): provider
// and model always travel together (a model only exists under its provider),
// effort rides along when the user picked one from the flyout.
async function laxSwitchModel(providerId, model, effort) {
  try {
    await apiFetch('/api/providers/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, model }),
    });
    try { const s = JSON.parse(localStorage.getItem('lax_settings') || '{}'); s.provider = providerId; s.model = model; localStorage.setItem('lax_settings', JSON.stringify(s)); } catch {}
    if (effort) await quickSwitchEffort(effort);
    _providersCacheTime = 0; // Force refresh
    await loadProviders();
    updateStatusBar(true);
  } catch (e) { console.warn('[provider] Switch failed:', e); }
}
