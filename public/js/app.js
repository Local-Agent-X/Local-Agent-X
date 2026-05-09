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

// Fetch chats from server (source of truth), merge with cache.
// Sidebar render only needs {id, title, updatedAt, messageCount} — full
// message bodies are fetched lazily in selectChat() on click. Eagerly
// fetching every session here used to fan-out 50+ GETs on page load,
// draining the per-token rate-limit bucket and 429ing legitimate work
// (voice session polls, WS reconnects). Pay the per-session cost only
// when the user actually opens that chat.
async function syncChatsFromServer() {
  try {
    const res = await fetch(`${API}/api/sessions`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) return;
    const serverList = await res.json(); // [{id, title, updatedAt, messageCount}]

    const localMap = new Map(chats.map(c => [c.id, c]));
    const merged = [];
    const seen = new Set();
    const deletedIds = getDeletedIds();

    for (const srv of serverList) {
      seen.add(srv.id);
      if (deletedIds[srv.id]) continue;
      const local = localMap.get(srv.id);
      // Mid-stream protection: NEVER replace the local chat object while a
      // stream is in flight for this session. Replacing it orphans the
      // streamChat closure reference in sendMessage.
      const isStreamingNow = local && (window.streamingSessionId === srv.id);
      if (local && (isStreamingNow || local.updatedAt >= srv.updatedAt)) {
        // Local copy is at-or-newer than server — keep it but tag if we
        // know full content is bigger than what's cached, so selectChat
        // knows to hydrate on click.
        const listTruncated = local.messages && typeof srv.messageCount === 'number' && srv.messageCount > local.messages.length;
        const hasTruncated = local.messages && local.messages.some(m => m._truncated || (typeof m.content === 'string' && m.content.length >= 9_900));
        if (!isStreamingNow && (listTruncated || hasTruncated)) local._needsHydrate = true;
        merged.push(local);
      } else {
        // Server is newer or session is server-only. Build a metadata stub —
        // selectChat will hydrate the body when the user clicks in.
        const stub = {
          id: srv.id,
          title: srv.title,
          updatedAt: srv.updatedAt,
          createdAt: srv.createdAt || (local && local.createdAt) || srv.updatedAt,
          messageCount: srv.messageCount,
          messages: (local && local.messages) || [],
          _needsHydrate: true,
        };
        if (local) {
          stub.projectId = local.projectId;
          stub.compactedAt = local.compactedAt;
          if (local.archived) stub.archived = true;
        }
        merged.push(stub);
      }
    }

    // Local-only sessions (not on server yet — newly created before first save)
    for (const local of chats) {
      if (!seen.has(local.id)) merged.push(local);
    }

    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    chats = merged;
    // If activeChat got replaced by a stub during the merge, swap the in-memory
    // pointer to the merged record so selectChat / renderMessages see the same
    // object that's in the chats[] array.
    if (activeChat) {
      const merged2 = chats.find(c => c.id === activeChat.id);
      if (merged2 && merged2 !== activeChat) activeChat = merged2;
    }
    saveChats();
    renderSidebar();
  } catch (e) {
    console.warn('[sync] Failed to fetch sessions from server:', e.message);
  }
}

// Save: write to localStorage immediately, push to server in background
function saveChats() {
  // Save chat metadata + last 10 messages per chat to localStorage. Cap per-message
  // content at 10_000 chars (from the original 500) — long-form LLM replies were being
  // silently truncated mid-sentence, and on refresh the truncated local version was
  // preferred over the full server version. Mark truncated messages with _truncated
  // so the sync merge knows to prefer the server copy.
  const PER_MSG_CAP = 10_000;
  const toSave = chats.map(c => {
    const rec = {
      id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      messages: c.messages.slice(-10).map(m => {
        const raw = m.content || "";
        const truncated = raw.length > PER_MSG_CAP;
        const content = truncated ? raw.slice(0, PER_MSG_CAP) : raw;
        const base = { role: m.role, content };
        if (truncated) base._truncated = true;
        if (m.attachments) base.attachments = m.attachments.map(a => {
          // Persist `url` (server-hosted, small string) so images survive
          // reload. The original code stripped url + dataUrl, leaving only
          // {name,size,type,isImage} — which makes addMessageEl fall through
          // to the placeholder badge instead of rendering the image.
          // dataUrl is intentionally NOT persisted because it can be MB
          // each (data:image/png;base64,…) and would blow localStorage quota.
          // If the upload completed, we have `url`; if it failed, we have
          // nothing and the badge fallback is correct.
          const out = { name: a.name, size: a.size, type: a.type, isImage: a.isImage };
          if (a.url) out.url = a.url;
          return out;
        });
        return base;
      }),
    };
    // Persist client-only flags that don't live on the server session JSON.
    // Without these, archive/unarchive and project assignment vanished on reload.
    if (c.archived) rec.archived = true;
    if (c.projectId) rec.projectId = c.projectId;
    if (c.compactedAt) rec.compactedAt = c.compactedAt;
    return rec;
  });
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
const ROUTES = ['chat', 'settings', 'secrets', 'protocols', 'missions', 'apps', 'agents'];
var _sidebarPins = []; // Dynamic pinned pages (var for cross-script WebSocket access)

function navigate(route) {
  const isPin = route.startsWith('pin:');
  if (!isPin && !ROUTES.includes(route)) route = 'chat';
  const prevRoute = currentRoute();
  location.hash = '#' + route;

  // Hide all built-in pages
  ROUTES.forEach(r => {
    const page = document.getElementById('page-' + r);
    if (!page) return;
    if (!isPin && r === route) {
      page.classList.add('active');
      if (r !== prevRoute && typeof Spring !== 'undefined') {
        page.style.opacity = '0';
        page.style.transform = 'translateY(12px)';
        Spring.animate(page, 'opacity', 1, { from: 0, preset: 'stiff' });
        Spring.animate(page, 'y', 0, { from: 12, preset: 'stiff', unit: 'px', onDone: () => { page.style.transform = ''; } });
      }
    } else {
      if (typeof Spring !== 'undefined') Spring.stop(page);
      page.style.opacity = '';
      page.style.transform = '';
      page.style.display = '';
      page.classList.remove('active');
    }
  });

  // Handle pinned page via iframe.
  // Always cache-bust on click so file changes from agents/workers show up.
  // Previously: only reloaded if URL changed → clicking the same tab after
  // an edit kept showing the OLD version until the user manually refreshed
  // the whole browser. Real workflow blocker since the agent/worker just
  // edited the app the user wants to verify.
  const pinPage = document.getElementById('page-pin');
  const pinIframe = document.getElementById('pin-iframe');
  if (isPin && pinPage && pinIframe) {
    const pinName = route.slice(4); // strip "pin:"
    const pin = _sidebarPins.find(p => p.name === pinName);
    if (pin) {
      // Pass auth token + cache-bust timestamp so iframe always reloads fresh.
      const sep = pin.url.includes('?') ? '&' : '?';
      const pinUrl = pin.url + sep + 'token=' + AUTH_TOKEN + '&_t=' + Date.now();
      pinIframe.src = pinUrl;
      pinPage.classList.add('active');
    }
  } else if (pinPage) {
    pinPage.classList.remove('active');
  }

  // Highlight active util button
  document.querySelectorAll('.util-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  // Highlight active pinned item
  document.querySelectorAll('.pinned-item').forEach(b => {
    b.classList.toggle('active', b.dataset.route === route);
  });
  // Init page if it has an init function
  if (!isPin && window['init_' + route]) window['init_' + route]();
  // Only show agents toggle on chat page
  var agentsBtn = document.getElementById('agents-toggle');
  if (agentsBtn) agentsBtn.style.display = (route === 'chat') ? '' : 'none';
}

function currentRoute() {
  const hash = location.hash.slice(1) || 'chat';
  if (hash.startsWith('pin:')) return hash;
  return ROUTES.includes(hash) ? hash : 'chat';
}

// ── Sidebar Pins (dynamic, agent-controllable) ──
function loadSidebarPins() {
  fetch('/api/sidebar/pins', { headers: { Authorization: 'Bearer ' + AUTH_TOKEN } })
    .then(r => r.ok ? r.json() : { pins: [] })
    .then(data => {
      _sidebarPins = data.pins || [];
      renderSidebarPins();
    }).catch(() => {});
}

function renderSidebarPins() {
  const section = document.getElementById('pinned-section');
  const list = document.getElementById('pinned-list');
  if (!section || !list) return;
  if (_sidebarPins.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = _sidebarPins.map(p =>
    '<div class="pinned-item" data-route="pin:' + esc(p.name) + '" onclick="navigate(\'pin:' + esc(p.name) + '\')" title="' + esc(p.name) + '">' +
      '<span class="pinned-icon">' + (p.icon || '📌') + '</span>' +
      '<span class="pinned-name">' + esc(p.name) + '</span>' +
    '</div>'
  ).join('');
}

// Load pins on startup and listen for WebSocket updates
document.addEventListener('DOMContentLoaded', loadSidebarPins);

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
  const currentTags = chatTags[chatId] || [];

  // Show TAG targets first (work/personal/research/debug — these are what users
  // actually mean when they say "move this chat to research"). Current tags
  // show as highlighted with a remove option. Then show projects if any.
  const tagRows = allTags.map(t => {
    const isActive = currentTags.includes(t);
    return `<div class="move-menu-item${isActive ? ' active' : ''}" onclick="${isActive ? `removeTagFromChat('${esc(chatId)}','${esc(t)}',event)` : `addTagToChat('${esc(chatId)}','${esc(t)}',event)`}">${isActive ? '\u2713 ' : ''}${esc(t)}</div>`;
  }).join('');

  const projectRows = projects.map(p =>
    `<div class="move-menu-item" onclick="moveChat('${esc(chatId)}','${esc(p.id)}',event)">&#128193; ${esc(p.name)}</div>`
  ).join('');

  const divider = (tagRows && projectRows) ? '<div class="move-menu-divider"></div>' : '';
  const removeRow = chat?.projectId ? `<div class="move-menu-item remove" onclick="moveChat('${esc(chatId)}','',event)">Remove from project</div>` : '';

  menu.innerHTML = tagRows + divider + projectRows + removeRow;
  if (!menu.innerHTML) menu.innerHTML = '<div class="move-menu-item" style="color:var(--muted)">No categories yet</div>';
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
  // Step 4: send-btn always enabled. When this chat is streaming, the
  // sendMessage handler routes the message as an interject into the
  // running turn. When not streaming, normal new-turn flow.
  if (sendBtn) sendBtn.disabled = false;
  // Subscribe to this chat's events via WS
  if (window.chatWs && window.chatWs.readyState === WebSocket.OPEN) {
    window.chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
  }
  // Lazy hydration: if the sidebar handed us a metadata stub (or a known-stale
  // local copy), fetch the full session JSON now. One fetch per click instead
  // of N on page load. Skip if we're already streaming into this chat.
  if (activeChat && activeChat._needsHydrate && !isThisChatStreaming) {
    hydrateChat(activeChat).catch(e => console.warn('[hydrate] failed:', e?.message));
  }
}

async function hydrateChat(chat) {
  try {
    const res = await fetch(`${API}/api/sessions/${chat.id}`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    if (!res.ok) { delete chat._needsHydrate; return; }
    const session = await res.json();
    // Preserve client-only fields the server doesn't know about.
    session.projectId = chat.projectId;
    session.compactedAt = chat.compactedAt;
    if (chat.archived) session.archived = true;
    // Mutate in place so the activeChat pointer (and any closures holding it)
    // stay valid. Replace messages, copy server fields.
    Object.assign(chat, session);
    delete chat._needsHydrate;
    saveChats();
    if (activeChat && activeChat.id === chat.id && window.renderMessages) renderMessages();
  } catch (e) {
    delete chat._needsHydrate;
    throw e;
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
  markDeleted(id);
  saveChats(); renderSidebar();
  if (window.renderMessages) renderMessages();
  apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

function renameChat(id, e) {
  e.stopPropagation();
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  const newTitle = prompt('Rename chat:', chat.title);
  if (!newTitle || newTitle === chat.title) return;
  chat.title = newTitle;
  saveChats(); renderSidebar();
  apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle }) }).catch(() => {});
}

function archiveChat(id, e) {
  e.stopPropagation();
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  // Toggle: archive if unarchived, unarchive if archived.
  chat.archived = !chat.archived;
  if (chat.archived && activeChat && activeChat.id === id) activeChat = null;
  saveChats(); renderSidebar();
  if (window.renderMessages) renderMessages();
}

async function exportChat(id, e) {
  e.stopPropagation();
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  if (chat._needsHydrate) {
    try { await hydrateChat(chat); } catch {}
  }
  let md = '# ' + (chat.title || 'Chat') + '\n\n';
  for (const m of (chat.messages || [])) {
    const role = m.role === 'user' ? 'You' : 'Agent';
    md += '**' + role + ':** ' + (m.content || '') + '\n\n---\n\n';
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (chat.title || 'chat').replace(/[^a-z0-9]/gi, '_') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
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

  let unassigned = chats.filter(c => !c.projectId && !c.archived);

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
        <button class="chat-action-btn" onclick="renameChat('${c.id}',event)" title="Rename" aria-label="Rename chat">&#9998;</button>
        <button class="chat-action-btn" onclick="showMoveMenu('${c.id}',event)" title="Move to project" aria-label="Move chat to project">&#128193;</button>
        <button class="chat-action-btn" onclick="togglePinChat('${c.id}',event)" title="${isPinned ? 'Unpin' : 'Pin'}" aria-label="${isPinned ? 'Unpin chat' : 'Pin chat'}">${isPinned ? '&#128204;' : '&#128392;'}</button>
        <button class="chat-action-btn" onclick="exportChat('${c.id}',event)" title="Export" aria-label="Export chat">&#128190;</button>
        <button class="chat-action-btn" onclick="archiveChat('${c.id}',event)" title="${c.archived ? 'Unarchive' : 'Archive'}" aria-label="${c.archived ? 'Unarchive chat' : 'Archive chat'}">${c.archived ? '&#128228;' : '&#128230;'}</button>
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

  // Group regular conversations by date
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;

  const groups = { pinned: [], today: [], yesterday: [], week: [], older: [] };
  for (const c of sortWithPins(regularChats)) {
    if (pinnedChatIds.includes(c.id)) { groups.pinned.push(c); continue; }
    const t = c.updatedAt || c.createdAt || 0;
    if (t >= todayStart) groups.today.push(c);
    else if (t >= yesterdayStart) groups.yesterday.push(c);
    else if (t >= weekStart) groups.week.push(c);
    else groups.older.push(c);
  }

  let html = tagBarHtml;
  const renderGroup = (label, items) => {
    if (items.length === 0) return '';
    return `<div class="chat-group-label">${label}</div>` + items.map(renderItem).join('');
  };
  html += renderGroup('Pinned', groups.pinned);
  html += renderGroup('Today', groups.today);
  html += renderGroup('Yesterday', groups.yesterday);
  html += renderGroup('This Week', groups.week);
  html += renderGroup('Older', groups.older);

  // Archived section — collapsed by default, click label to toggle visibility
  const archivedChats = chats.filter(c => c.archived && !c.id?.startsWith('wa-') && !c.id?.startsWith('tg-'));
  if (archivedChats.length > 0) {
    const isOpen = localStorage.getItem('sax_archived_open') === '1';
    html += `<div class="chat-group-label" style="cursor:pointer;user-select:none" onclick="toggleArchivedSection()">${isOpen ? '&#9662;' : '&#9656;'} Archived (${archivedChats.length})</div>`;
    if (isOpen) {
      html += archivedChats.map(renderItem).join('');
    }
  }

  el.innerHTML = html || '<div style="padding:8px 12px;font-size:.72rem;color:var(--muted)">No chats yet. Click + New Chat.</div>';
}

function toggleArchivedSection() {
  const open = localStorage.getItem('sax_archived_open') === '1';
  localStorage.setItem('sax_archived_open', open ? '0' : '1');
  renderChatList();
}

function renderSidebar() {
  renderProjects();
  renderChatList();
}

// ── Init ──
renderSidebar();
checkAuth();
window.addEventListener('hashchange', () => navigate(currentRoute()));
// Defer initial navigate to DOMContentLoaded so per-route init functions
// (init_chat, etc.) defined in later <script> tags exist by the time we
// dispatch. Running at top-level here would race chat.js loading and skip
// initStatusBar — leaving the provider/model dropdowns blank until the
// user manually triggers a re-navigate (e.g. clicking "New Chat").
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => navigate(currentRoute()));
} else {
  navigate(currentRoute());
}

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
        <button class="update-btn" onclick="window.open('https://github.com/petermanrique101-sys/Local-Agent-X','_blank')">View on GitHub</button>
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
