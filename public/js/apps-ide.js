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

function enterIdeView(appId, appName, appUrl, buildPrompt) {
  _ideAppId = appId;
  _ideSessionId = 'ide-' + appId + '-' + Date.now();
  _ideContent = '';
  _ideToolCount = 0;
  _ideTrackedAgents = {};
  window._ideAppUrl = appUrl;

  // Hide gallery, show IDE
  const gallery = document.querySelector('#page-apps .page-header');
  const body = document.querySelector('#page-apps .page-body');
  const ide = document.getElementById('apps-ide');
  if (gallery) gallery.style.display = 'none';
  if (body) body.style.display = 'none';
  if (ide) ide.style.display = 'flex';

  // Set app name
  const nameEl = document.getElementById('ide-app-name');
  if (nameEl) nameEl.textContent = appName || appId;

  // Clear chat and add welcome
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.innerHTML = '';

  // Set status bar
  ideSetStatus('ready', 'Ready');

  // Always use workspace file path for preview (not registry render URL)
  const port = location.port || '7007';
  window._ideAppUrl = `http://127.0.0.1:${port}/apps/${_ideAppId}/index.html`;

  const frame = document.getElementById('ide-preview-frame');
  if (appUrl && frame) {
    frame.src = window._ideAppUrl;
  } else if (frame) {
    frame.srcdoc = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui;color:#999;background:#1a1a2e"><div style="text-align:center"><div style="font-size:2rem;margin-bottom:12px;opacity:.5">&#9881;</div><div>Waiting for build...</div></div></div>';
  }

  // Load file tree
  ideLoadFiles();

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
  loadApps();
}

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
function sendIdeChatMessage() {
  if (_ideStreaming) return;
  const input = document.getElementById('ide-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  ideAddMessage('user', text);
  ideSendToAgent(ideContextPrefix() + text);
}

function ideContextPrefix() {
  return 'IMPORTANT: You are in IDE mode editing an app. ' +
    'Do NOT use agent_spawn, delegate, or build_app tools. ' +
    'Do the work YOURSELF using read, write, edit, bash, glob, and grep tools directly. ' +
    'Work in workspace/apps/' + _ideAppId + '/. ';
}

function ideSendToAgent(message) {
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
      message: message, attachments: []
    }));
  }
}

function ideDisableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  if (input) { input.disabled = true; input.placeholder = 'Agent is working...'; }
  if (btn) btn.disabled = true;
}

function ideEnableInput() {
  const input = document.getElementById('ide-chat-input');
  const btn = document.getElementById('ide-chat-send');
  if (input) { input.disabled = false; input.placeholder = 'Describe changes...'; input.focus(); }
  if (btn) btn.disabled = false;
}

// ── Chat messages ──
function ideAddMessage(role, text, isPlaceholder) {
  const msgs = document.getElementById('ide-chat-messages');
  if (!msgs) return;
  const el = document.createElement('div');
  el.className = 'ide-msg ' + role;
  if (role === 'assistant' && isPlaceholder) {
    el.innerHTML = '<div class="ide-thinking"><span></span><span></span><span></span></div>';
    el.id = 'ide-assistant-active';
  } else {
    el.innerHTML = typeof md === 'function' ? md(text) : text;
  }
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
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

// Exports
window.enterIdeView = enterIdeView;
window.exitIdeView = exitIdeView;
window.sendIdeChatMessage = sendIdeChatMessage;
window.toggleIdeChat = toggleIdeChat;
window.toggleIdeFiles = toggleIdeFiles;
window.ideRefreshPreview = ideRefreshPreview;
window.ideCloseFileViewer = ideCloseFileViewer;
window.ideViewFile = ideViewFile;
