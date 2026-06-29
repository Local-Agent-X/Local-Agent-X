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

// Reveal the IDE "Restart backend" button only for apps that actually have a
// registered backend dev server. One source of truth (the /api/apps hasBackend
// flag) so every IDE entry path — card, post-build, session-restore — is right.
async function refreshIdeBackendButton(appId) {
  const btn = document.getElementById('ide-restart-backend-btn');
  if (!btn) return;
  btn.style.display = 'none';
  try {
    const r = await fetch(`${API}/api/apps`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const apps = await r.json();
    const me = Array.isArray(apps) ? apps.find(a => a.id === appId) : null;
    if (me && me.hasBackend) btn.style.display = '';
  } catch { /* leave hidden */ }
}

// Restart a Tier-1.5 backend dev server. Backend SOURCE edits don't take effect
// until the dev server bounces (it stays live ~15 min, so closing and reopening
// the app doesn't restart it). POSTs /api/apps/<id>/restart-backend, which does
// a clean kill-then-restart server-side. Shared by the app-card button
// (apps.js) and the IDE topbar; both load as global scripts.
async function restartBackend(id, name, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
  try {
    const r = await fetch(`${API}/api/apps/${id}/restart-backend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    const data = await r.json().catch(() => ({}));
    if (btn) {
      btn.textContent = r.ok ? 'Restarted ✓' : 'Failed';
      btn.title = r.ok ? `Backend restarted on port ${data.port}` : (data.error || 'Restart failed');
      setTimeout(() => { btn.disabled = false; btn.textContent = label || 'Restart backend'; }, 1600);
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Failed'; setTimeout(() => { btn.disabled = false; btn.textContent = label || 'Restart backend'; }, 1600); }
  }
}

// Restart the current IDE app's backend (delegates to the shared handler above).
function ideRestartBackend() {
  if (!_ideAppId) return;
  restartBackend(_ideAppId, _ideAppId, document.getElementById('ide-restart-backend-btn'));
}

function enterIdeView(appId, appName, appUrl, buildPrompt) {
  _ideAppId = appId;
  refreshIdeBackendButton(appId);
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
window.toggleIdeChat = toggleIdeChat;
window.toggleIdeFiles = toggleIdeFiles;
