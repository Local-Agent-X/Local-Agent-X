// ── App Shell: Sidebar + Router ──
// The sidebar persists across all "pages" — state never resets.

let chats = loadChatsFromCache(); // Start with cache, then fetch from server
let projects = loadProjects();
let activeChat = null;
let expandedProjects = new Set();
let serverSyncing = false; // Prevent save loops
let chatSearchQuery = ''; // Chat search filter
let pinnedChatIds = loadPinnedChats(); // Pinned chat IDs
let chatTags = loadChatTags(); // {chatId: [tags]}
let allTags = loadAllTags(); // All known tags
let activeTagFilter = ''; // Current tag filter

function loadPinnedChats() { try { return JSON.parse(localStorage.getItem('sax_pinned_chats') || '[]'); } catch { return []; } }
function savePinnedChats() { localStorage.setItem('sax_pinned_chats', JSON.stringify(pinnedChatIds)); }
function loadChatTags() { try { return JSON.parse(localStorage.getItem('sax_chat_tags') || '{}'); } catch { return {}; } }
function saveChatTags() { localStorage.setItem('sax_chat_tags', JSON.stringify(chatTags)); localStorage.setItem('sax_all_tags', JSON.stringify(allTags)); }
function loadAllTags() { try { return JSON.parse(localStorage.getItem('sax_all_tags') || '["work","personal","research","debug"]'); } catch { return ['work','personal','research','debug']; } }

function togglePinChat(id, e) {
  e.stopPropagation();
  const idx = pinnedChatIds.indexOf(id);
  if (idx >= 0) pinnedChatIds.splice(idx, 1);
  else pinnedChatIds.push(id);
  savePinnedChats(); renderSidebar();
}

function addTagToChat(chatId, tag, e) {
  if (e) e.stopPropagation();
  if (!chatTags[chatId]) chatTags[chatId] = [];
  if (!chatTags[chatId].includes(tag)) chatTags[chatId].push(tag);
  if (!allTags.includes(tag)) allTags.push(tag);
  saveChatTags(); renderSidebar();
}

function removeTagFromChat(chatId, tag, e) {
  if (e) e.stopPropagation();
  if (chatTags[chatId]) chatTags[chatId] = chatTags[chatId].filter(t => t !== tag);
  saveChatTags(); renderSidebar();
}

function showTagMenu(chatId, e) {
  e.stopPropagation();
  document.querySelectorAll('.tag-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'tag-menu';
  const currentTags = chatTags[chatId] || [];
  menu.innerHTML = allTags.map(t =>
    `<div class="tag-menu-item ${currentTags.includes(t) ? 'active' : ''}" onclick="${currentTags.includes(t) ? `removeTagFromChat('${esc(chatId)}','${esc(t)}',event)` : `addTagToChat('${esc(chatId)}','${esc(t)}',event)`}">${esc(t)}</div>`
  ).join('') + `<div class="tag-menu-item add-tag" onclick="promptNewTag('${esc(chatId)}',event)">+ New tag</div>`;
  e.target.closest('.chat-item').appendChild(menu);
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 10);
}

function promptNewTag(chatId, e) {
  e.stopPropagation();
  const tag = prompt('New tag name:');
  if (!tag) return;
  const cleaned = tag.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
  if (!cleaned) return;
  addTagToChat(chatId, cleaned);
}

function filterByTag(tag) {
  activeTagFilter = (activeTagFilter === tag) ? '' : tag;
  renderSidebar();
}

function onChatSearch(val) {
  chatSearchQuery = val.toLowerCase();
  renderSidebar();
}

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
    saveChats(); // Uses the safe, truncated save
    renderSidebar();
  } catch (e) {
    console.warn('[sync] Failed to fetch sessions from server:', e.message);
  }
}

// Save: write to localStorage immediately, push to server in background
function saveChats() {
  // Only save chat metadata + last 10 messages per chat to localStorage (prevents quota overflow)
  // Full history lives on the server in ~/.sax/sessions/
  const toSave = chats.map(c => ({
    id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messages: c.messages.slice(-10).map(m => {
      if (!m.attachments) return { role: m.role, content: (m.content || '').slice(0, 500) };
      return { role: m.role, content: (m.content || '').slice(0, 500), attachments: m.attachments.map(a => ({ name: a.name, size: a.size, type: a.type, isImage: a.isImage })) };
    })
  }));
  try {
    localStorage.setItem('sax_chats_v2', JSON.stringify(toSave));
  } catch (e) {
    // Quota exceeded — prune oldest chats and retry
    console.warn('[storage] Quota exceeded, pruning old chats');
    while (toSave.length > 5) { toSave.pop(); }
    try { localStorage.setItem('sax_chats_v2', JSON.stringify(toSave)); } catch {}
  }
}

function loadProjects() { try { return JSON.parse(localStorage.getItem('sax_projects_v1') || '[]'); } catch { return []; } }
function saveProjects() { localStorage.setItem('sax_projects_v1', JSON.stringify(projects)); }

// Sync from server on page load (after initial render from cache)
setTimeout(() => syncChatsFromServer(), 500);

// ── Routing ──
const ROUTES = ['chat', 'settings', 'secrets', 'cron', 'dashboards', 'agents'];

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
  // Only show agents toggle on chat page
  var agentsBtn = document.getElementById('agents-toggle');
  if (agentsBtn) agentsBtn.style.display = (route === 'chat') ? '' : 'none';
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
    `<div class="move-menu-item" onclick="moveChat('${esc(chatId)}','${esc(p.id)}',event)">${esc(p.name)}</div>`
  ).join('') + (chat?.projectId ? `<div class="move-menu-item remove" onclick="moveChat('${esc(chatId)}','',event)">Remove from project</div>` : '');
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

  let unassigned = chats.filter(c => !c.projectId);

  // Apply search filter
  if (chatSearchQuery) {
    unassigned = unassigned.filter(c => {
      if ((c.title || '').toLowerCase().includes(chatSearchQuery)) return true;
      return (c.messages || []).some(m => (m.content || '').toLowerCase().includes(chatSearchQuery));
    });
  }

  // Apply tag filter
  if (activeTagFilter) {
    unassigned = unassigned.filter(c => (chatTags[c.id] || []).includes(activeTagFilter));
  }

  const waChats = unassigned.filter(c => c.id && c.id.startsWith('wa-'));
  const tgChats = unassigned.filter(c => c.id && c.id.startsWith('tg-'));
  const regularChats = unassigned.filter(c => !c.id || (!c.id.startsWith('wa-') && !c.id.startsWith('tg-')));

  // Sort: pinned first, then by date
  const sortWithPins = (arr) => {
    const pinned = arr.filter(c => pinnedChatIds.includes(c.id));
    const unpinned = arr.filter(c => !pinnedChatIds.includes(c.id));
    return [...pinned, ...unpinned];
  };

  const renderItem = (c) => {
    const isPinned = pinnedChatIds.includes(c.id);
    const tags = chatTags[c.id] || [];
    return `
    <div class="chat-item ${activeChat && activeChat.id === c.id ? 'active' : ''}${isPinned ? ' pinned' : ''}" onclick="selectChat('${c.id}')" role="option" aria-selected="${activeChat && activeChat.id === c.id}">
      <span class="chat-dot${typeof isChatActive==='function'&&isChatActive(c.id)?' active-pulse':''}"></span>
      <span class="chat-title">${isPinned ? '<span class="pin-icon" title="Pinned">&#128204;</span> ' : ''}${esc(c.title)}</span>
      ${tags.length ? `<span class="chat-tags-inline">${tags.map(t => `<span class="tag-pill-sm">${esc(t)}</span>`).join('')}</span>` : ''}
      <span class="chat-actions">
        <button class="chat-action-btn" onclick="togglePinChat('${c.id}',event)" title="${isPinned ? 'Unpin' : 'Pin'}" aria-label="${isPinned ? 'Unpin chat' : 'Pin chat'}">${isPinned ? '&#128204;' : '&#128392;'}</button>
        <button class="chat-action-btn" onclick="showTagMenu('${c.id}',event)" title="Tags" aria-label="Manage tags">&#127991;</button>
        ${projects.length ? `<button class="chat-action-btn" onclick="showMoveMenu('${c.id}',event)" title="Move" aria-label="Move to project">&#8618;</button>` : ''}
        <button class="chat-action-btn delete" onclick="deleteChat('${c.id}',event)" title="Delete" aria-label="Delete chat">&times;</button>
      </span>
    </div>
  `;
  };

  // WhatsApp section
  const waEl = document.getElementById('wa-chat-list');
  const waSection = document.getElementById('wa-chats-section');
  if (waEl && waSection) {
    if (waChats.length > 0) { waSection.style.display = ''; waEl.innerHTML = waChats.map(renderItem).join(''); }
    else { waSection.style.display = 'none'; }
  }

  // Telegram section
  const tgEl = document.getElementById('tg-chat-list');
  const tgSection = document.getElementById('tg-chats-section');
  if (tgEl && tgSection) {
    if (tgChats.length > 0) { tgSection.style.display = ''; tgEl.innerHTML = tgChats.map(renderItem).join(''); }
    else { tgSection.style.display = 'none'; }
  }

  // Tag filter bar
  let tagBarHtml = '';
  if (allTags.length > 0) {
    tagBarHtml = `<div class="tag-filter-bar" role="toolbar" aria-label="Filter by tag">${allTags.map(t =>
      `<button class="tag-pill${activeTagFilter === t ? ' active' : ''}" onclick="filterByTag('${esc(t)}')" aria-pressed="${activeTagFilter === t}">${esc(t)}</button>`
    ).join('')}</div>`;
  }

  // Regular conversations
  el.innerHTML = tagBarHtml + sortWithPins(regularChats).map(renderItem).join('')
    || '<div style="padding:8px 12px;font-size:.72rem;color:var(--muted)">No chats yet. Click + New Chat.</div>';
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

// Auto-refresh sidebar every 30s to pick up new WhatsApp sessions
setInterval(() => {
  syncChatsFromServer().then(() => renderChatList()).catch(() => {});
}, 30000);

// ── Update checker (runs on startup) ──
(async function checkForUpdates() {
  // Don't annoy users — only check once per session, and respect dismissal
  if (sessionStorage.getItem('sax_update_dismissed')) return;
  try {
    const res = await apiFetch('/api/updates/check');
    const data = await res.json();
    if (data.updateAvailable) {
      const banner = document.getElementById('update-banner');
      if (!banner) return;
      banner.style.display = '';
      banner.className = 'visible';
      banner.innerHTML = `
        <span class="update-msg">Update available: v${esc(data.remoteVersion)}${data.remoteCommit ? ' (' + esc(data.remoteCommit) + ')' : ''}${data.releaseNotes ? ' — ' + esc(data.releaseNotes) : ''}</span>
        <button class="update-btn" onclick="window.open('https://github.com/petermanrique101-sys/Open-Agent-X','_blank')">View on GitHub</button>
        <button class="update-dismiss" onclick="dismissUpdate()" title="Dismiss">&times;</button>
      `;
    }
  } catch {}
})();

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) { banner.style.display = 'none'; banner.className = ''; }
  sessionStorage.setItem('sax_update_dismissed', '1');
}
