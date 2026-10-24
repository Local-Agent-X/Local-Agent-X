// ── App Shell: the sidebar's Chat / Code toggle ──
// A session is a chat or a code session (src/session/mode.ts), fixed when it
// is created. The toggle picks which side the sidebar shows: the chat side is
// the sidebar as it always was; the code side lists code sessions grouped by
// the project folder each works in, plus the App IDE's sessions under Apps.
// Which side shows is a per-machine convenience, remembered in localStorage.
// Reads app-state.js's `chats` / `projects` / `activeChat`; loads after it.

const SIDEBAR_MODE_KEY = 'lax_sidebar_mode';
let sidebarMode = (() => {
  try { return localStorage.getItem(SIDEBAR_MODE_KEY) === 'code' ? 'code' : 'chat'; } catch { return 'chat'; }
})();
try { window.sidebarMode = sidebarMode; } catch {}

/** A chat object's mode: the server's `mode`, or an App IDE id. */
function chatModeOf(c) {
  return c && (c.mode === 'code' || (typeof c.id === 'string' && c.id.startsWith('ide-'))) ? 'code' : 'chat';
}

/** Does the side now showing list this chat? */
function inSidebarMode(c) {
  return chatModeOf(c) === sidebarMode;
}

function setSidebarMode(mode) {
  sidebarMode = mode === 'code' ? 'code' : 'chat';
  try { window.sidebarMode = sidebarMode; localStorage.setItem(SIDEBAR_MODE_KEY, sidebarMode); } catch {}
  renderSidebarModeToggle();
  renderSidebar();
}

/** The toggle's state, the New row's label, and the chat-only sections. */
function renderSidebarModeToggle() {
  for (const m of ['chat', 'code']) {
    const btn = document.getElementById(`sidebar-mode-${m}`);
    if (!btn) continue;
    btn.classList.toggle('active', sidebarMode === m);
    btn.setAttribute('aria-pressed', String(sidebarMode === m));
  }
  const label = document.getElementById('new-chat-label');
  if (label) label.textContent = sidebarMode === 'code' ? 'New code session' : 'New chat';
  // Pinned apps, chat projects, chat search, the messaging bridges and the
  // Conversations heading belong to the chat side; the code side's groups
  // carry their own headings.
  for (const id of ['pinned-section', 'projects-section', 'chat-search-bar', 'mobile-section', 'chats-header']) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden-in-code-mode', sidebarMode === 'code');
  }
}

/** The New row: a chat or a code session, by the side showing. */
function newFromSidebar() {
  if (sidebarMode === 'code') newCodeSession();
  else newChat();
}

/** A new code session, in a project's folder when one is given. */
function newCodeSession(projectId) {
  newChat(projectId, 'code');
}

function codeSessionRow(c) {
  const active = activeChat && activeChat.id === c.id;
  const pulse = typeof isChatActive === 'function' && isChatActive(c.id) ? ' active-pulse' : '';
  return `
    <div class="chat-item ${active ? 'active' : ''}" onclick="selectChat('${c.id}')" role="option" aria-selected="${active}">
      <span class="chat-dot${pulse}"></span>
      <span class="chat-title">${esc(c.title)}</span>
      <span class="chat-actions">
        <button class="chat-action-btn" onclick="renameChat('${c.id}',event)" title="Rename" aria-label="Rename session">&#9998;</button>
        <button class="chat-action-btn delete" onclick="deleteChat('${c.id}',event)" title="Delete" aria-label="Delete session">&times;</button>
      </span>
    </div>`;
}

function codeGroup(title, rows, addAction) {
  const add = addAction ? `<button class="add-btn" onclick="${addAction};event.stopPropagation()" title="New session here">+</button>` : '';
  return `
    <div class="code-group">
      <div class="section-header code-group-header"><span>${esc(title)}</span>${add}</div>
      ${rows.join('') || '<div class="code-group-empty">No sessions yet</div>'}
    </div>`;
}

/** The code side: one group per project folder, Apps, then sessions with no folder. */
function renderCodeSidebar(el) {
  const code = chats.filter(c => chatModeOf(c) === 'code' && !c.archived);
  const folders = (projects || []).filter(p => p.workspace);
  const html = [];
  for (const p of folders) {
    html.push(codeGroup(p.name, code.filter(c => c.projectId === p.id && !c.id.startsWith('ide-')).map(codeSessionRow), `newCodeSession('${p.id}')`));
  }
  const apps = code.filter(c => c.id.startsWith('ide-'));
  if (apps.length) html.push(codeGroup('Apps', apps.map(codeSessionRow)));
  const loose = code.filter(c => !c.id.startsWith('ide-') && !folders.some(p => p.id === c.projectId));
  if (loose.length) html.push(codeGroup('No folder', loose.map(codeSessionRow)));
  html.push(`<div class="code-add-folder" onclick="addProjectFolder()" role="button" tabindex="0">+ Add a project folder</div>`);
  el.innerHTML = html.join('');
}

/**
 * Edit on an app: open its code session (`ide-<appId>`, the App IDE's own, so
 * the history carries on) in the main chat, on the code side, with the right
 * panel on Preview. The server anchors the session at the app's folder from
 * its id (src/session/ide-work-root.ts).
 */
function openAppCodeSession(appId, name) {
  const id = `ide-${appId}`;
  if (!chats.some(c => c.id === id)) {
    chats.unshift({ id, title: name || appId, mode: 'code', messages: [], createdAt: Date.now(), updatedAt: Date.now(), _needsHydrate: true });
  }
  if (sidebarMode !== 'code') setSidebarMode('code');
  selectChat(id);
  if (typeof agentFeedsOpen !== 'undefined' && !agentFeedsOpen && typeof toggleAgentFeeds === 'function') toggleAgentFeeds();
  if (typeof switchSidePanelTab === 'function') switchSidePanelTab('preview');
}

// "Open in Code" on an app build's result (chat-agent-feeds-render.js
// resultLinkHtml), on its Agents card or inbox item. Captured, so the card's
// or row's own click does not also run.
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-open-code]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openAppCodeSession(btn.getAttribute('data-open-code'));
}, true);

/** A project whose folder code sessions work in (POST /api/projects with `workspace`). */
async function addProjectFolder() {
  const folder = (prompt('Path of the project folder (for example C:\\Users\\you\\my-app):') || '').trim();
  if (!folder) return;
  const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
  try {
    const r = await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ name, workspace: folder }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    if (typeof syncProjectsFromServer === 'function') await syncProjectsFromServer();
  } catch (e) {
    alert(`Couldn't add that folder: ${e.message}`);
  }
}

// The toggle reflects the side remembered from last time; the DOM is parsed
// (app shell scripts load at the end of <body>).
renderSidebarModeToggle();
