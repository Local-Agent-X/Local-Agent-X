// ── App IDE View — core ──
// Three-panel editing experience: chat (left) | preview (center) | files (right)
// WS event routing: apps-ide-ws.js
// Tool cards + preview iframe + file tree: apps-ide-tools-files.js
// Background-agent tracking: apps-ide-agents.js

let _ideAppId = null;
let _ideSessionId = null;
let _ideStreaming = false;
let _ideContent = '';
let _ideWsHandler = null;
let _ideToolCount = 0;
let _ideStartTime = 0;
let _ideTimerInterval = null;
let _ideAgentPollInterval = null;
let _ideTrackedAgents = {}; // agentId -> { name, role, status }
let idePendingUploads = []; // IDE-side mirror of pendingUploads; populated by chat-uploads.js via the 'ide' context

// Register the IDE upload context with chat-uploads.js so paste / drop / +
// button all route into idePendingUploads when the user is in IDE view.
// The registry itself is created in chat-uploads.js (loads earlier); this
// just adds the 'ide' entry. Same factory pattern as the 'main' entry.
window.__uploadContexts = window.__uploadContexts || {};
window.__uploadContexts.ide = {
  fileInputId: 'ide-file-input',
  previewsId: 'ide-upload-previews',
  getState: () => idePendingUploads,
  setState: (arr) => { idePendingUploads = arr; },
};

function enterIdeView(appId, appName, appUrl, buildPrompt) {
  _ideAppId = appId;
  // Stable session ID per app so chat persists across leave/return. Used
  // to be `ide-${appId}-${Date.now()}` which made every IDE entry a fresh
  // session — user lost the conversation as soon as they navigated away
  // and back. Now one chat per app, accumulates across sessions.
  _ideSessionId = 'ide-' + appId;
  _ideContent = '';
  _ideToolCount = 0;
  _ideTrackedAgents = {};
  window._ideAppUrl = appUrl;

  // Hide gallery, show IDE. Fullscreen class hides the sidebar + hamburger
  // toggles — IDE is a focused mode, sidebar nav competes with the 3-panel
  // layout. Back-to-Apps lives in the IDE topbar.
  const gallery = document.querySelector('#page-apps .page-header');
  const body = document.querySelector('#page-apps .page-body');
  const ide = document.getElementById('apps-ide');
  if (gallery) gallery.style.display = 'none';
  if (body) body.style.display = 'none';
  if (ide) ide.style.display = 'flex';
  document.body.classList.add('ide-fullscreen');
  // Persist so a renderer reload (Electron crash, F5, accidental refresh)
  // can drop the user back into the same IDE session instead of dumping
  // them at the apps gallery. Restore happens in ideRestoreSession() on
  // page init.
  try { localStorage.setItem('lax_ide_open', JSON.stringify({ id: appId, name: appName, url: appUrl })); } catch {}

  // Set app name
  const nameEl = document.getElementById('ide-app-name');
  if (nameEl) nameEl.textContent = appName || appId;

  // Clear chat and load any prior conversation for this app's stable
  // session. Async — the bubbles populate when the fetch returns; the
  // user can keep interacting in the meantime.
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.innerHTML = '';
  ideLoadHistory();

  // Set status bar
  ideSetStatus('ready', 'Ready');

  // Always use workspace file path for preview (not registry render URL)
  const port = location.port || '7007';
  window._ideAppUrl = `http://127.0.0.1:${port}/apps/${_ideAppId}/index.html`;

  const frame = document.getElementById('ide-preview-frame');
  if (appUrl && frame) {
    try { frame.src = 'about:blank'; } catch {}
    frame.src = window._ideAppUrl + '?_t=' + Date.now();
    // Re-inject the picker if it's on (e.g. user toggled it, navigated
    // away and back). Idempotent — noops if the iframe is empty.
    if (typeof _ideOnPreviewLoad === 'function') {
      frame.addEventListener('load', _ideOnPreviewLoad, { once: true });
    }
    if (typeof _ideOnPreviewLoadErrors === 'function') {
      frame.addEventListener('load', _ideOnPreviewLoadErrors, { once: true });
    }
  } else if (frame) {
    frame.srcdoc = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui;color:#999;background:#1a1a2e"><div style="text-align:center"><div style="font-size:2rem;margin-bottom:12px;opacity:.5">&#9881;</div><div>Waiting for build...</div></div></div>';
  }

  // Load file tree
  ideLoadFiles();

  // Wire up provider+model selectors so the user can switch mid-session.
  // Safe between turns — each turn picks model fresh from /api/settings
  // at request prep. Mid-turn changes only affect the next turn.
  ideInitModelSelector();

  // Set up WS listener for this session
  ideAttachWsListener();

  // Subscribe to this IDE session on WS
  if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: _ideSessionId }));
  }

  // If building a new app, send the prompt immediately
  if (buildPrompt) {
    ideAddMessage('user', buildPrompt);
    ideSendToAgent(ideContextPrefix() + 'Build me an app: ' + buildPrompt);
  }
}

function exitIdeView() {
  if (_ideWsHandler && typeof chatWs !== 'undefined' && chatWs) {
    chatWs.removeEventListener('message', _ideWsHandler);
  }
  if (_ideTimerInterval) clearInterval(_ideTimerInterval);
  ideStopAgentPolling();
  _ideWsHandler = null;
  _ideAppId = null;
  _ideSessionId = null;
  _ideStreaming = false;
  _ideTrackedAgents = {};

  const gallery = document.querySelector('#page-apps .page-header');
  const body = document.querySelector('#page-apps .page-body');
  const ide = document.getElementById('apps-ide');
  if (gallery) gallery.style.display = '';
  if (body) body.style.display = '';
  if (ide) ide.style.display = 'none';
  document.body.classList.remove('ide-fullscreen');
  try { localStorage.removeItem('lax_ide_open'); } catch {}
  loadApps();
}

// Called on apps-page init. If the user was inside the IDE when the
// renderer reloaded (Electron crash, F5, OOM from huge npm installs),
// restore them to the same IDE session so they don't lose their place.
function ideRestoreSession() {
  try {
    const raw = localStorage.getItem('lax_ide_open');
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.id) return false;
    // Defer one tick so #apps-ide and its children are in the DOM
    setTimeout(() => enterIdeView(saved.id, saved.name || saved.id, saved.url || null), 0);
    return true;
  } catch { return false; }
}
window.ideRestoreSession = ideRestoreSession;

// ── Provider / model selector ──
async function ideInitModelSelector() {
  const provSel = document.getElementById('ide-provider-select');
  const modelSel = document.getElementById('ide-model-select');
  if (!provSel || !modelSel) return;
  // Reuse APPS_PROVIDERS / APPS_MODELS if the apps gallery already
  // hydrated them; otherwise fetch the registry ourselves (cheap, cached
  // by the server).
  let providers = (typeof APPS_PROVIDERS !== 'undefined' && APPS_PROVIDERS.length) ? APPS_PROVIDERS : null;
  let models = (typeof APPS_MODELS !== 'undefined' && Object.keys(APPS_MODELS).length) ? APPS_MODELS : null;
  if (!providers || !models) {
    try {
      const reg = await apiFetch('/api/providers/registry').then(r => r.json());
      providers = (reg.providers || []).map(p => ({ value: p.id, label: p.label }));
      models = Object.fromEntries((reg.providers || []).map(p => [p.id, p.models]));
      if (typeof APPS_PROVIDERS !== 'undefined') { APPS_PROVIDERS = providers; APPS_MODELS = models; }
    } catch { providers = providers || []; models = models || {}; }
  }
  window._ideModelsByProvider = models;
  provSel.innerHTML = providers.map(p => `<option value="${p.value}">${p.label}</option>`).join('');
  try {
    const r = await apiFetch('/api/settings');
    const s = await r.json();
    if (s.provider) provSel.value = s.provider;
    populateIdeModels(s.provider || provSel.value, s.model);
  } catch { populateIdeModels(provSel.value); }
}

function populateIdeModels(provider, currentModel) {
  const modelSel = document.getElementById('ide-model-select');
  if (!modelSel) return;
  const list = (window._ideModelsByProvider && window._ideModelsByProvider[provider]) || [];
  if (list.length) {
    modelSel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join('');
    modelSel.style.display = '';
    if (currentModel && list.includes(currentModel)) modelSel.value = currentModel;
  } else {
    modelSel.innerHTML = '<option value="">default</option>';
    modelSel.style.display = provider === 'local' ? 'none' : '';
  }
}

function onIdeProviderChange(provider) {
  populateIdeModels(provider);
  const model = document.getElementById('ide-model-select')?.value || '';
  apiPost('/api/settings', { provider, model }).catch(() => {});
  // Keep the apps gallery selectors in sync so user doesn't see drift
  const galProv = document.getElementById('apps-provider-select');
  if (galProv && typeof populateAppsModels === 'function') { galProv.value = provider; populateAppsModels(provider, model); }
}

function onIdeModelChange(model) {
  const provider = document.getElementById('ide-provider-select')?.value;
  apiPost('/api/settings', { provider, model }).catch(() => {});
  const galModel = document.getElementById('apps-model-select');
  if (galModel) galModel.value = model;
}

window.onIdeProviderChange = onIdeProviderChange;
window.onIdeModelChange = onIdeModelChange;

// ── Status bar ──
function ideSetStatus(state, text) {
  const bar = document.getElementById('ide-status-bar');
  if (!bar) return;
  const dot = state === 'working' ? '<span class="ide-status-dot pulse"></span>' :
              state === 'done' ? '<span class="ide-status-dot done"></span>' :
              state === 'error' ? '<span class="ide-status-dot error"></span>' :
              '<span class="ide-status-dot"></span>';
  bar.innerHTML = dot + '<span class="ide-status-text">' + text + '</span>' +
    (state === 'working' ? '<span id="ide-timer" class="ide-timer"></span>' : '');
}

function ideStartTimer() {
  _ideStartTime = Date.now();
  if (_ideTimerInterval) clearInterval(_ideTimerInterval);
  _ideTimerInterval = setInterval(() => {
    const el = document.getElementById('ide-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - _ideStartTime) / 1000);
    el.textContent = s < 60 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's';
  }, 1000);
}

function ideStopTimer() {
  if (_ideTimerInterval) { clearInterval(_ideTimerInterval); _ideTimerInterval = null; }
}

// ── Send & input ──
async function sendIdeChatMessage() {
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text && idePendingUploads.length === 0) return;

  // Mid-stream inject: the agent's mid-turn already. Send the text into the
  // running op's inject queue instead of starting a new turn. Server's
  // interjectDrainMiddleware picks it up at the next iteration boundary so
  // the agent sees the new instruction without abandoning current work.
  // (Same path main chat uses; see chat-send.js inject branch.) Inject
  // messages don't carry attachments today — same constraint as main chat;
  // queued files surface on the next non-inject send.
  if (_ideStreaming) {
    if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
      const injectId = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : ('inj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
      chatWs.send(JSON.stringify({ type: 'inject', sessionId: _ideSessionId, message: text, injectId }));
      input.value = '';
      input.style.height = 'auto';
      // Echo locally so the user sees the inject landed; no [queued] styling
      // because the IDE doesn't render queue-state (main chat does — the IDE
      // intentionally stays lighter).
      ideAddMessage('user', text);
    }
    return;
  }

  // Wait for any in-flight uploads to finish before capturing attachments.
  // Hard 8s ceiling per chat-send.js — a hung server would otherwise leave
  // a pending promise forever and block this and every future send.
  const inflight = idePendingUploads.filter(f => f._uploadPromise).map(f => f._uploadPromise);
  if (inflight.length > 0) {
    await Promise.race([
      Promise.all(inflight),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }
  const msgAttachments = idePendingUploads.length ? idePendingUploads.map(f => ({
    name: f.name, size: f.size, type: f.type, isImage: f.isImage,
    url: f.url || null, dataUrl: f.dataUrl || null,
  })) : null;
  const hasImages = msgAttachments && msgAttachments.some(a => a.isImage);
  const nonImageFiles = msgAttachments ? msgAttachments.filter(a => !a.isImage) : [];
  const uploadPrefix = nonImageFiles.length
    ? `Attached files:\n${nonImageFiles.map(f => `- ${f.name} (${f.size} bytes)`).join('\n')}\n\n`
    : '';
  const displayText = text || (hasImages ? '' : '');

  input.value = '';
  input.style.height = 'auto';
  idePendingUploads = [];
  if (window.__uploadContexts && window.__uploadContexts.ide) window.__uploadContexts.ide.setState([]);
  if (typeof renderUploadPreviews === 'function') renderUploadPreviews('ide');

  ideAddMessage('user', displayText, false, msgAttachments);
  const errPrefix = (typeof ideDrainErrorsForAgent === 'function') ? ideDrainErrorsForAgent() : '';
  ideSendToAgent(ideContextPrefix() + errPrefix + uploadPrefix + text, msgAttachments);
}

function ideContextPrefix() {
  return 'IMPORTANT: You are in IDE mode editing an app. ' +
    'If the user is asking a question, brainstorming, or asking what to do next ' +
    '(e.g. "what should we add?", "what do you think?", "any ideas?", "should we...?"), ' +
    'reply in chat with your suggestions FIRST and wait for an explicit go-ahead before editing. ' +
    'Only start editing files when given a clear directive ("add X", "fix Y", "build it", "do it", "go"). ' +
    'Do NOT use agent_spawn, delegate, or build_app tools. ' +
    'When you do edit, do the work YOURSELF using read, write, edit, bash, glob, and grep tools directly. ' +
    'Work in workspace/apps/' + _ideAppId + '/. ' +
    'Do NOT include http://127.0.0.1 URLs in your reply — the user is viewing the app in a live preview iframe next to this chat, so any "open the app here" link is redundant noise. ';
}
// Marker used to strip the prefix from displayed user messages so the
// hidden IDE instructions don't show up as a chat bubble when history reloads.
const IDE_PREFIX_MARKER = 'IMPORTANT: You are in IDE mode editing an app.';
function ideStripPrefix(text) {
  if (typeof text !== 'string' || !text.startsWith(IDE_PREFIX_MARKER)) return text;
  // Prefix ends at the last sentence-ending period before the user's real text.
  // Pattern: a series of sentences ending in '. ', then the user content.
  // Cheapest robust match: find 'workspace/apps/{id}/. ' OR 'redundant noise. '
  // and slice past it. Fall back to the original text if no match.
  const cuts = [/redundant noise\.\s+/, new RegExp('workspace/apps/[^/]+/\\.\\s+')];
  for (const re of cuts) {
    const m = text.match(re);
    if (m && m.index != null) return text.slice(m.index + m[0].length);
  }
  return text;
}

function ideSendToAgent(message, attachments) {
  _ideStreaming = true;
  _ideContent = '';
  _ideToolCount = 0;
  ideDisableInput();
  ideSetStatus('working', 'Thinking...');
  ideStartTimer();
  ideAddMessage('assistant', '', true);

  if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({
      type: 'chat', sessionId: _ideSessionId,
      message: message, attachments: attachments || []
    }));
  }
}

function ideDisableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  const stopBtn = document.getElementById('ide-chat-stop');
  // Keep input + send-btn ENABLED during streaming: sendIdeChatMessage routes
  // typed text to the inject queue when _ideStreaming. Locking the input
  // prevented the user from steering mid-turn ("actually use blue", "skip the
  // header"); main chat's composer made the same choice.
  if (input) { input.placeholder = 'Working… type to inject into this turn'; }
  if (stopBtn) stopBtn.style.display = 'flex';
}

function ideEnableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  const stopBtn = document.getElementById('ide-chat-stop');
  if (input) { input.disabled = false; input.placeholder = 'Describe changes...'; input.focus(); }
  if (btn) btn.disabled = false;
  if (stopBtn) stopBtn.style.display = 'none';
}

// Send {type: 'stop', sessionId} — server's handleStop cancels the canonical
// op + releases the turn lock. Same signal main chat's stopChat sends; do
// NOT close-and-reconnect the WS (main chat does that as a sledgehammer
// and it would kill any concurrent main-chat stream). HTTP fallback in case
// the WS dropped.
function stopIdeChat() {
  if (!_ideSessionId) return;
  if (typeof chatWs !== 'undefined' && chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: _ideSessionId }));
  }
  if (typeof apiFetch === 'function') {
    apiFetch('/api/chats/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: _ideSessionId }),
    }).catch(() => {});
  }
  // Mark the in-flight assistant message as stopped so the user sees the
  // cancellation took effect before the server's `done`/`error` event arrives
  // (which can lag a few seconds). Match main chat's [stopped by user] style.
  const activeEl = document.getElementById('ide-assistant-active');
  if (activeEl) {
    const textEl = activeEl.querySelector('.ide-text') || activeEl;
    if (!textEl.textContent.includes('[stopped')) {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--muted);font-size:.72rem;margin-top:8px;font-style:italic';
      note.textContent = '[stopped by user]';
      activeEl.appendChild(note);
    }
    activeEl.removeAttribute('id');
  }
  _ideStreaming = false;
  _ideContent = '';
  ideStopTimer();
  ideSetStatus('ready', 'Stopped');
  ideEnableInput();
}
window.stopIdeChat = stopIdeChat;

// Wipe this app's stable session and reset the UI. Used by the Fresh
// Chat button in the topbar — the session is per-app and accumulates
// over many builds, so the user needs an explicit "start over" affordance
// when the conversation has drifted or they just want a clean slate.
async function ideFreshChat() {
  if (!_ideSessionId) return;
  if (!confirm('Wipe this app\'s chat history and start fresh? The app files stay put — only the conversation is reset.')) return;
  try {
    await apiFetch('/api/sessions/' + encodeURIComponent(_ideSessionId), { method: 'DELETE' });
  } catch { /* if delete fails, still reset the UI — server can have a stale row, user sees a clean chat */ }
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.innerHTML = '';
  _ideContent = '';
  _ideToolCount = 0;
  _ideTrackedAgents = {};
  ideSetStatus('ready', 'Ready');
}
window.ideFreshChat = ideFreshChat;

// Fetch and render the user/assistant history for this app's stable
// session. UI-projection view drops tool-call detail rows — we just want
// the conversation bubbles. Silent-fail: a fresh app has no session yet
// (404), nothing to render.
async function ideLoadHistory() {
  if (!_ideSessionId) return;
  try {
    const r = await apiFetch('/api/sessions/' + encodeURIComponent(_ideSessionId));
    if (!r.ok) return;
    const session = await r.json();
    const list = Array.isArray(session?.messages) ? session.messages : [];
    for (const m of list) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const raw = typeof m.content === 'string' ? m.content : '';
      if (!raw) continue;
      const text = m.role === 'user' ? ideStripPrefix(raw) : raw;
      if (!text) continue;
      ideAddMessage(m.role, text);
    }
  } catch { /* fresh session or transient — fine to skip */ }
}

// ── Chat messages ──
function __ideAttachmentHtml(attachments) {
  if (!attachments || !attachments.length) return '';
  const safeEsc = (typeof esc === 'function') ? esc : (s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]));
  return '<div class="msg-attachments">' + attachments.map(a => {
    if (a.isImage && a.dataUrl) {
      return `<img src="${safeEsc(a.dataUrl)}" alt="${safeEsc(a.name)}" onclick="typeof openLightbox==='function'&&openLightbox(this.src)" title="${safeEsc(a.name)}" loading="lazy" />`;
    } else if (a.isImage && a.url) {
      const tok = (typeof AUTH_TOKEN !== 'undefined') ? AUTH_TOKEN : '';
      const authedUrl = a.url + (a.url.includes('?') ? '&' : '?') + 'token=' + tok;
      return `<img src="${safeEsc(authedUrl)}" alt="${safeEsc(a.name)}" onclick="typeof openLightbox==='function'&&openLightbox(this.src)" title="${safeEsc(a.name)}" loading="lazy" />`;
    } else if (a.isImage) {
      return `<div class="att-badge"><span>&#128444;</span> ${safeEsc(a.name)}</div>`;
    } else {
      return `<div class="att-badge"><span>&#128196;</span> ${safeEsc(a.name)} (${(a.size / 1024).toFixed(1)}KB)</div>`;
    }
  }).join('') + '</div>';
}

function ideAddMessage(role, text, isPlaceholder, attachments) {
  const msgs = document.getElementById('ide-chat-messages');
  if (!msgs) return;
  const el = document.createElement('div');
  el.className = 'ide-msg ' + role;
  if (role === 'assistant' && isPlaceholder) {
    el.innerHTML = '<div class="ide-thinking"><span></span><span></span><span></span></div>';
    el.id = 'ide-assistant-active';
  } else {
    const attachHtml = __ideAttachmentHtml(attachments);
    const body = typeof md === 'function' ? md(text || '') : (text || '');
    el.innerHTML = attachHtml + body;
    if (typeof text === 'string') el.dataset.rawText = text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  // Re-scroll after images decode (height changes once they paint).
  const imgs = el.querySelectorAll('.msg-attachments img');
  if (imgs.length) imgs.forEach(img => img.onload = () => { msgs.scrollTop = msgs.scrollHeight; });
}

// ── Panel toggles ──
function toggleIdeChat() {
  const panel = document.getElementById('ide-chat-panel');
  const btn = document.querySelector('.ide-topbar-btn[onclick*="toggleIdeChat"]');
  if (panel) panel.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('active', panel && !panel.classList.contains('collapsed'));
}

function toggleIdeFiles() {
  const panel = document.getElementById('ide-files-panel');
  const btn = document.querySelector('.ide-topbar-btn[onclick*="toggleIdeFiles"]');
  if (panel) panel.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('active', panel && !panel.classList.contains('collapsed'));
}

// Exports — only for symbols defined in THIS file. Functions defined in
// sibling scripts (ideRefreshPreview / ideCloseFileViewer / ideViewFile
// live in apps-ide-tools-files.js) export themselves at the bottom of
// the file they're defined in, otherwise the script-load order races
// and the bare identifier here throws ReferenceError, killing every
// export below it (broke the onIdeProviderChange + error-pipe init
// registrations).
window.enterIdeView = enterIdeView;
window.exitIdeView = exitIdeView;
window.sendIdeChatMessage = sendIdeChatMessage;
window.toggleIdeChat = toggleIdeChat;
window.toggleIdeFiles = toggleIdeFiles;
