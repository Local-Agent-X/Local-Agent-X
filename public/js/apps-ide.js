// ── App IDE View ──
// Three-panel editing experience: chat (left) | preview (center) | files (right)
// Claude Code-style tool activity, streaming, and status bar

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

// ── WebSocket event handler ──
function ideAttachWsListener() {
  if (_ideWsHandler && typeof chatWs !== 'undefined' && chatWs) {
    chatWs.removeEventListener('message', _ideWsHandler);
  }
  _ideWsHandler = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type !== 'event' || msg.sessionId !== _ideSessionId) return;
      const ev = msg.event;
      switch (ev.type) {
        case 'stream':
          _ideContent += ev.delta;
          ideUpdateAssistantMsg(_ideContent);
          break;
        case 'tool_start':
          _ideToolCount++;
          ideSetStatus('working', ideToolLabel(ev.toolName, ev.args));
          ideAddToolCard(ev.toolName, ev.args, ev.riskLevel, ev.context);
          break;
        case 'tool_end': {
          ideFinishToolCard(ev.toolName, ev.result, ev.allowed !== false);
          const toolName = ev.toolName;
          if (['write','edit','build_app','bash'].includes(toolName)) {
            ideRefreshPreview();
            ideLoadFiles();
          }
          ideSetStatus('working', 'Thinking...');
          break;
        }
        case 'agent_spawn':
          if (ev.agent) {
            _ideTrackedAgents[ev.agent.id] = ev.agent;
            ideAddAgentCard(ev.agent);
            ideStartAgentPolling();
            ideSetStatus('working', 'Agent: ' + (ev.agent.name || ev.agent.role || 'working') + '...');
          }
          break;
        case 'agent_status':
          if (ev.agentId) ideUpdateAgentCard(ev.agentId, ev);
          break;
        case 'done':
          _ideStreaming = false;
          _ideContent = '';
          const activeEl = document.getElementById('ide-assistant-active');
          if (activeEl) activeEl.removeAttribute('id');
          // If agents are still running, keep status as working
          if (ideHasActiveAgents()) {
            ideSetStatus('working', 'Agent working...');
          } else {
            ideStopTimer();
            ideSetStatus('done', 'Done (' + _ideToolCount + ' tool' + (_ideToolCount !== 1 ? 's' : '') + ')');
            ideEnableInput();
          }
          ideRefreshPreview();
          ideLoadFiles();
          break;
        case 'error':
          _ideStreaming = false;
          _ideContent = '';
          ideStopTimer();
          ideStopAgentPolling();
          ideSetStatus('error', ev.message || ev.error || 'Error');
          ideAddMessage('assistant', 'Error: ' + (ev.message || ev.error || 'Something went wrong'));
          ideEnableInput();
          break;
      }
    } catch (err) { /* ignore */ }
  };
  if (typeof chatWs !== 'undefined' && chatWs) {
    chatWs.addEventListener('message', _ideWsHandler);
  }
}

// ── Tool label helper ──
function ideToolLabel(name, args) {
  if (typeof toolSummary === 'function') return toolSummary(name, args);
  switch (name) {
    case 'build_app': return 'Building app...';
    case 'write': return 'Writing ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'edit': return 'Editing ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'read': return 'Reading ' + ((args && args.path) || 'file').split(/[/\\]/).pop();
    case 'bash': return 'Running: ' + ((args && args.command) || '').slice(0, 40);
    case 'glob': return 'Searching files...';
    case 'grep': return 'Searching code...';
    default: return name + '...';
  }
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

function ideUpdateAssistantMsg(content) {
  let el = document.getElementById('ide-assistant-active');
  if (!el) {
    ideAddMessage('assistant', '', true);
    el = document.getElementById('ide-assistant-active');
  }
  if (!el) return;
  // First stream event: drop the thinking indicator so text can replace it
  const thinking = el.querySelector('.ide-thinking');
  if (thinking) thinking.remove();
  // Maintain a dedicated text node separate from tool cards so neither clobbers the other
  let textEl = el.querySelector('.ide-text');
  if (!textEl) {
    textEl = document.createElement('div');
    textEl.className = 'ide-text';
    el.insertBefore(textEl, el.firstChild);
  }
  textEl.innerHTML = typeof md === 'function' ? md(content) : content;
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

// ── Tool cards (same style as main chat) ──
function ideAddToolCard(name, args, riskLevel, context) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  // Remove thinking indicator if present
  const thinking = el.querySelector('.ide-thinking');
  if (thinking) thinking.remove();

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.tool = name;
  card.innerHTML =
    '<div class="tool-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
      '<span class="indicator"></span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      '<span style="color:var(--muted);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
        esc(ideToolLabel(name, args)) +
      '</span>' +
      '<span class="ide-tool-spinner"></span>' +
    '</div>' +
    '<div class="tool-detail">' + esc(ideFormatToolArgs(name, args)) + '</div>';
  el.appendChild(card);
  const msgs = document.getElementById('ide-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function ideFinishToolCard(name, result, allowed) {
  const el = document.getElementById('ide-assistant-active');
  if (!el) return;
  const cards = el.querySelectorAll('.tool-card[data-tool="' + name + '"]');
  const card = cards[cards.length - 1];
  if (!card) return;
  const indicator = card.querySelector('.indicator');
  if (indicator) indicator.className = 'indicator ' + (allowed ? 'allowed' : 'blocked');
  const spinner = card.querySelector('.ide-tool-spinner');
  if (spinner) spinner.remove();
  // Add result preview to detail
  if (result) {
    const detail = card.querySelector('.tool-detail');
    if (detail) {
      const preview = typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500);
      detail.textContent += '\n\n' + preview;
    }
  }
}

function ideFormatToolArgs(name, args) {
  if (!args) return '';
  switch (name) {
    case 'write': case 'read': case 'edit': return args.path || '';
    case 'bash': return '$ ' + (args.command || '');
    case 'build_app': return (args.name || '') + ': ' + (args.prompt || '').slice(0, 100);
    case 'glob': return args.pattern || '';
    case 'grep': return args.pattern || '';
    default: return JSON.stringify(args).slice(0, 200);
  }
}

// ── Preview ──
let _ideRefreshTimer = null;

function ideRefreshPreview() {
  // Debounce: wait 500ms after last call so file writes flush to disk
  if (_ideRefreshTimer) clearTimeout(_ideRefreshTimer);
  _ideRefreshTimer = setTimeout(_ideDoRefresh, 500);
}

function _ideDoRefresh() {
  _ideRefreshTimer = null;
  const frame = document.getElementById('ide-preview-frame');
  if (!frame || !_ideAppId) return;
  // Always use the workspace file URL, never the registry render URL
  const port = location.port || '7007';
  const appUrl = `http://127.0.0.1:${port}/apps/${_ideAppId}/index.html`;
  window._ideAppUrl = appUrl;
  frame.src = appUrl + '?_t=' + Date.now();
}

// ── File tree ──
async function ideLoadFiles() {
  const tree = document.getElementById('ide-file-tree');
  if (!tree || !_ideAppId) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/files`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    if (!r.ok) { tree.innerHTML = '<div class="ide-file-empty">No files yet</div>'; return; }
    const files = await r.json();
    if (!Array.isArray(files) || files.length === 0) {
      tree.innerHTML = '<div class="ide-file-empty">No files yet</div>';
      return;
    }
    tree.innerHTML = files.map(f => {
      const ext = f.split('.').pop() || '';
      const icon = { html: '&#128196;', css: '&#127912;', js: '&#9881;', ts: '&#9881;', json: '&#128203;', md: '&#128221;', png: '&#128444;', svg: '&#128444;' }[ext] || '&#128196;';
      return `<div class="ide-file-item" onclick="ideViewFile('${esc(f)}')" title="${esc(f)}">
        <span class="icon">${icon}</span><span class="name">${esc(f)}</span>
      </div>`;
    }).join('');
  } catch {
    tree.innerHTML = '<div class="ide-file-empty">Could not load files</div>';
  }
}

async function ideViewFile(filename) {
  const tree = document.getElementById('ide-file-tree');
  const viewer = document.getElementById('ide-file-viewer');
  const nameEl = document.getElementById('ide-file-viewer-name');
  const contentEl = document.getElementById('ide-file-viewer-content');
  if (!viewer || !contentEl) return;
  try {
    const r = await fetch(`${API}/api/apps/${_ideAppId}/files/${encodeURIComponent(filename)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    if (!r.ok) throw new Error('Failed to fetch');
    const text = await r.text();
    if (nameEl) nameEl.textContent = filename;
    contentEl.textContent = text;
    if (tree) tree.style.display = 'none';
    viewer.style.display = 'flex';
  } catch {
    contentEl.textContent = 'Failed to load file';
  }
}

function ideCloseFileViewer() {
  const tree = document.getElementById('ide-file-tree');
  const viewer = document.getElementById('ide-file-viewer');
  if (tree) tree.style.display = '';
  if (viewer) viewer.style.display = 'none';
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
