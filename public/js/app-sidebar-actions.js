// ── App Shell: Sidebar interactive mutations ──
// Chat CRUD, project CRUD, tag/pin mutations, and the move/tag context menus.
// All state lives in app-state.js; sync helpers in app-sync.js. This file is
// purely user-driven mutations + the small menus that drive them.

// ── Tag / pin / search actions ──
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

// ── Project CRUD ──
async function newProject() {
  const name = prompt('Project name:');
  if (!name) return;
  try {
    await fetch(`${API}/api/projects/from-starter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ name, description: '', agentIds: [] }),
    });
    await syncProjectsFromServer();
  } catch (e) { alert('Failed to create project: ' + (e?.message || e)); }
}

async function deleteProject(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this project? Chats inside it will be detached but kept.')) return;
  try {
    const res = await fetch(`${API}/api/projects/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!res.ok) {
      // Without this check the delete looked like it succeeded — the
      // fetch resolved fine on 404/403/500 — then syncProjectsFromServer
      // brought the project back from the backend and the user thought
      // "it keeps coming back." Surface the real failure instead.
      alert(`Failed to delete project (HTTP ${res.status}). The project is still on the server.`);
      await syncProjectsFromServer();
      return;
    }
    // Detach any chats that were nested under this project. Chats stay
    // in localStorage; deleting a server project doesn't delete chats.
    chats.forEach(c => { if (c.projectId === id) delete c.projectId; });
    saveChats();
    await syncProjectsFromServer();
  } catch (err) { alert('Failed to delete project: ' + (err?.message || err)); }
}

function toggleProject(id) {
  if (expandedProjects.has(id)) expandedProjects.delete(id);
  else expandedProjects.add(id);
  renderSidebar();
}

function projectChatsCount(pid) { return chats.filter(c => c.projectId === pid).length; }

// ── Move / tag context menu (mixed targets) ──
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
    return `<div class="move-menu-item${isActive ? ' active' : ''}" onclick="${isActive ? `removeTagFromChat('${esc(chatId)}','${esc(t)}',event)` : `addTagToChat('${esc(chatId)}','${esc(t)}',event)`}">${isActive ? '✓ ' : ''}${esc(t)}</div>`;
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

// ── Chat CRUD ──
// First-install greeting removed 2026-05-17. The canned bubble felt fake
// (pre-written string injected into an empty chat before any real
// interaction). The agent now greets the user as part of its FIRST real
// LLM reply — see the "First-turn identity ask" rule in config/system-prompt.md.
// Identity-extract pipeline on the user's reply is unchanged.
function newChat(projectId) {
  activeChat = { id: 'chat-' + uid(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  if (projectId) activeChat.projectId = projectId;
  try { window.activeChat = activeChat; } catch {}
  chats.unshift(activeChat);
  // Expand the project the new chat lives under so the user can see it.
  if (projectId && typeof expandedProjects !== 'undefined') expandedProjects.add(projectId);
  // No canned greeting — agent generates a real first reply when the user
  // sends their first message (see system-prompt.md "First-turn identity ask").
  saveChats(); renderSidebar();
  navigate('chat');
  if (window.renderMessages) renderMessages();
  // New chat is never streaming — reset UI
  if (window.streamingSessionId !== undefined) window.streamingSessionId = null;
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sendBtn) sendBtn.disabled = false;
  focusChatInput();
}

// Focus the message textarea after the page-switch spring has applied. Two
// rAFs put us past Electron's first paint where focus() otherwise no-ops
// (renderer reports the element isn't yet focusable). Browser tabs don't
// hit this because their focus subsystem doesn't gate on paint timing.
function focusChatInput() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ta = document.getElementById('msg-input');
    if (ta && !ta.disabled) ta.focus();
  }));
}

function newChatInProject(projectId, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (!projectId) return;
  newChat(projectId);
}

function selectChat(id) {
  activeChat = chats.find(c => c.id === id) || null;
  try { window.activeChat = activeChat; } catch {}
  renderSidebar();
  try { if (typeof window.updateStatusBar === 'function') window.updateStatusBar(); } catch {}
  navigate('chat');
  if (window.renderMessages) renderMessages();
  // Update send/stop button state for THIS chat
  const isThisChatStreaming = window.streamingSessionId === id;
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = isThisChatStreaming ? 'flex' : 'none';
  // Step 4: send-btn always enabled. When this chat is streaming, the
  // sendMessage handler routes the message as an interject into the
  // running turn. When not streaming, normal new-turn flow. The visual
  // mode (inject vs send) + the toolbar STREAMING pill are driven from
  // updateStreamUI() — single source of truth bound to streamingSessionId
  // + activeChat. Call it here on chat-switch so we don't carry stale UI.
  if (sendBtn) sendBtn.disabled = false;
  try { if (typeof updateStreamUI === 'function') updateStreamUI(); } catch {}
  // Subscribe to this chat's events via WS
  if (window.chatWs && window.chatWs.readyState === WebSocket.OPEN) {
    window.chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
  }
  focusChatInput();
  // Lazy hydration: if the sidebar handed us a metadata stub (or a known-stale
  // local copy), fetch the full session JSON now. One fetch per click instead
  // of N on page load. Skip if we're already streaming into this chat.
  if (activeChat && activeChat._needsHydrate && !isThisChatStreaming) {
    hydrateChat(activeChat).catch(e => console.warn('[hydrate] failed:', e?.message));
  }
}

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
