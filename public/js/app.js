// ── App Shell: Sidebar + Router ──
// The sidebar persists across all "pages" — state never resets.

let chats = loadChatsFromCache(); // Start with cache, then fetch from server
let projects = loadProjects();
let activeChat = null;
let expandedProjects = new Set();
let serverSyncing = false; // Prevent save loops

// Cache-only load (instant, for page load)
function loadChatsFromCache() { try { return JSON.parse(localStorage.getItem('sax_chats_v2') || '[]'); } catch { return []; } }

// Fetch chats from server (source of truth), merge with cache
async function syncChatsFromServer() {
  try {
    const res = await fetch(`${API}/api/sessions`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) return;
    const serverList = await res.json(); // [{id, title, updatedAt, messageCount}]

    // Build map of server sessions
    const serverMap = new Map(serverList.map(s => [s.id, s]));
    const localMap = new Map(chats.map(c => [c.id, c]));

    // Merge: server wins for sessions it knows about, keep local-only sessions
    const merged = [];
    const seen = new Set();

    // Server sessions first (sorted by updatedAt desc)
    const deletedIds = getDeletedIds();
    for (const srv of serverList) {
      seen.add(srv.id);
      // Skip tombstoned sessions — they were deliberately deleted
      if (deletedIds[srv.id]) continue;
      const local = localMap.get(srv.id);
      if (local && local.updatedAt >= srv.updatedAt) {
        merged.push(local);
      } else if (local) {
        try {
          const full = await fetch(`${API}/api/sessions/${srv.id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
          if (full.ok) {
            const session = await full.json();
            session.projectId = local.projectId;
            session.compactedAt = local.compactedAt;
            merged.push(session);
          } else merged.push(local);
        } catch { merged.push(local); }
      } else {
        // Server-only session (from another machine) — skip if tombstoned
        try {
          const full = await fetch(`${API}/api/sessions/${srv.id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
          if (full.ok) merged.push(await full.json());
        } catch {}
      }
    }

    // Local-only sessions (not on server yet — newly created before first save)
    for (const local of chats) {
      if (!seen.has(local.id)) merged.push(local);
    }

    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chats = merged;
    localStorage.setItem('sax_chats_v2', JSON.stringify(chats));
    renderSidebar();
  } catch (e) {
    console.warn('[sync] Failed to fetch sessions from server:', e.message);
  }
}

// Save: write to localStorage immediately, push to server in background
function saveChats() {
  const toSave = chats.map(c => ({
    ...c,
    messages: c.messages.map(m => {
      if (!m.attachments) return m;
      return { ...m, attachments: m.attachments.map(a => ({ name: a.name, size: a.size, type: a.type, isImage: a.isImage, url: a.url })) };
    })
  }));
  localStorage.setItem('sax_chats_v2', JSON.stringify(toSave));
}

function loadProjects() { try { return JSON.parse(localStorage.getItem('sax_projects_v1') || '[]'); } catch { return []; } }
function saveProjects() { localStorage.setItem('sax_projects_v1', JSON.stringify(projects)); }

// Sync from server on page load (after initial render from cache)
setTimeout(() => syncChatsFromServer(), 500);

// ── Routing ──
const ROUTES = ['chat', 'settings', 'secrets', 'cron'];

function navigate(route) {
  if (!ROUTES.includes(route)) route = 'chat';
  location.hash = '#' + route;
  ROUTES.forEach(r => {
    const page = document.getElementById('page-' + r);
    if (page) page.classList.toggle('active', r === route);
  });
  // Highlight active util button
  document.querySelectorAll('.util-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  // Init page if it has an init function
  if (window['init_' + route]) window['init_' + route]();
}

function currentRoute() {
  const hash = location.hash.slice(1) || 'chat';
  return ROUTES.includes(hash) ? hash : 'chat';
}

// ── Projects ──
function newProject() {
  const name = prompt('Project name:');
  if (!name) return;
  projects.push({ id: uid(), name, createdAt: Date.now() });
  saveProjects();
  renderSidebar();
}

function deleteProject(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this project?')) return;
  chats.forEach(c => { if (c.projectId === id) delete c.projectId; });
  projects = projects.filter(p => p.id !== id);
  saveProjects(); saveChats(); renderSidebar();
}

function toggleProject(id) {
  if (expandedProjects.has(id)) expandedProjects.delete(id);
  else expandedProjects.add(id);
  renderSidebar();
}

function projectChatsCount(pid) { return chats.filter(c => c.projectId === pid).length; }

function showMoveMenu(chatId, e) {
  e.stopPropagation();
  document.querySelectorAll('.move-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'move-menu';
  const chat = chats.find(c => c.id === chatId);
  menu.innerHTML = projects.map(p =>
    `<div class="move-menu-item" onclick="moveChat('${chatId}','${p.id}',event)">${esc(p.name)}</div>`
  ).join('') + (chat?.projectId ? `<div class="move-menu-item remove" onclick="moveChat('${chatId}','',event)">Remove from project</div>` : '');
  e.target.closest('.chat-item').appendChild(menu);
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 10);
}

function moveChat(chatId, projectId, e) {
  e.stopPropagation();
  const chat = chats.find(c => c.id === chatId);
  if (chat) { if (projectId) chat.projectId = projectId; else delete chat.projectId; }
  saveChats(); renderSidebar();
}

// ── Chats ──
function newChat() {
  activeChat = { id: 'chat-' + uid(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  chats.unshift(activeChat);
  saveChats(); renderSidebar();
  navigate('chat');
  if (window.renderMessages) renderMessages();
  // New chat is never streaming — reset UI
  if (window.streamingSessionId !== undefined) window.streamingSessionId = null;
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sendBtn) sendBtn.disabled = false;
}

function selectChat(id) {
  activeChat = chats.find(c => c.id === id) || null;
  renderSidebar();
  navigate('chat');
  if (window.renderMessages) renderMessages();
  // Update send/stop button state for THIS chat
  const isThisChatStreaming = window.streamingSessionId === id;
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = isThisChatStreaming ? 'flex' : 'none';
  if (sendBtn) sendBtn.disabled = isThisChatStreaming;
  // Subscribe to this chat's events via WS
  if (window.chatWs && window.chatWs.readyState === WebSocket.OPEN) {
    window.chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
  }
}

// Tombstones: track deleted session IDs so sync doesn't resurrect them
function getDeletedIds() { try { return JSON.parse(localStorage.getItem('sax_deleted_sessions') || '{}'); } catch { return {}; } }
function markDeleted(id) {
  const deleted = getDeletedIds();
  deleted[id] = Date.now();
  // Prune tombstones older than 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(deleted)) { if (v < cutoff) delete deleted[k]; }
  localStorage.setItem('sax_deleted_sessions', JSON.stringify(deleted));
}
function isDeleted(id) { return !!getDeletedIds()[id]; }

function deleteChat(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this chat?')) return;
  chats = chats.filter(c => c.id !== id);
  if (activeChat && activeChat.id === id) activeChat = null;
  markDeleted(id); // Record tombstone so sync doesn't bring it back
  saveChats(); renderSidebar();
  if (window.renderMessages) renderMessages();
  apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

// ── Sidebar rendering ──
function renderProjects() {
  const el = document.getElementById('project-list');
  if (!el) return;
  if (projects.length === 0) {
    el.innerHTML = '<div style="padding:4px 12px;font-size:.72rem;color:var(--muted)">No projects yet</div>';
    return;
  }
  el.innerHTML = projects.map(p => {
    const expanded = expandedProjects.has(p.id);
    const count = projectChatsCount(p.id);
    const pChats = chats.filter(c => c.projectId === p.id);
    return `
      <div class="project-item ${expanded ? 'expanded' : ''}" onclick="toggleProject('${p.id}')">
        <span class="project-arrow">&#9654;</span>
        <span class="project-name">${esc(p.name)}</span>
        ${count ? `<span class="project-count">${count}</span>` : ''}
        <button class="project-delete" onclick="deleteProject('${p.id}',event)" title="Delete">&times;</button>
      </div>
      <div class="project-chats">
        ${pChats.map(c => `
          <div class="chat-item ${activeChat && activeChat.id === c.id ? 'active' : ''}" onclick="selectChat('${c.id}')">
            <span class="chat-dot${typeof isChatActive==='function'&&isChatActive(c.id)?' active-pulse':''}"></span>
            <span class="chat-title">${esc(c.title)}</span>
            <span class="chat-actions">
              <button class="chat-action-btn" onclick="showMoveMenu('${c.id}',event)" title="Move">&#8618;</button>
              <button class="chat-action-btn delete" onclick="deleteChat('${c.id}',event)" title="Delete">&times;</button>
            </span>
          </div>
        `).join('')}
        ${pChats.length === 0 ? '<div style="padding:4px 8px;font-size:.7rem;color:var(--muted)">No chats</div>' : ''}
      </div>
    `;
  }).join('');
}

function renderChatList() {
  const el = document.getElementById('chat-list');
  if (!el) return;
  const unassigned = chats.filter(c => !c.projectId);
  el.innerHTML = unassigned.map(c => `
    <div class="chat-item ${activeChat && activeChat.id === c.id ? 'active' : ''}" onclick="selectChat('${c.id}')">
      <span class="chat-dot${typeof isChatActive==='function'&&isChatActive(c.id)?' active-pulse':''}"></span>
      <span class="chat-title">${esc(c.title)}</span>
      <span class="chat-actions">
        ${projects.length ? `<button class="chat-action-btn" onclick="showMoveMenu('${c.id}',event)" title="Move">&#8618;</button>` : ''}
        <button class="chat-action-btn delete" onclick="deleteChat('${c.id}',event)" title="Delete">&times;</button>
      </span>
    </div>
  `).join('') || '<div style="padding:8px 12px;font-size:.72rem;color:var(--muted)">No chats yet. Click + New Chat.</div>';
}

function renderSidebar() {
  renderProjects();
  renderChatList();
}

// ── Init ──
renderSidebar();
checkAuth();
window.addEventListener('hashchange', () => navigate(currentRoute()));
navigate(currentRoute());
