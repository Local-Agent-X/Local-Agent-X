// ── App Shell: Sidebar interactive mutations ──
// Chat CRUD, project CRUD, tag/pin mutations, and the move/tag context menus.
// All state lives in app-state.js; sync helpers in app-sync.js. This file is
// purely user-driven mutations + the small menus that drive them.

// ── Pin / search actions ──
function togglePinChat(id, e) {
  e.stopPropagation();
  const idx = pinnedChatIds.indexOf(id);
  if (idx >= 0) pinnedChatIds.splice(idx, 1);
  else pinnedChatIds.push(id);
  savePinnedChats(); renderSidebar();
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
  if (expandedProjects.has(id)) {
    expandedProjects.delete(id);
  } else {
    expandedProjects.add(id);
    touchProject(id);
  }
  renderSidebar();
}

function projectChatsCount(pid) { return chats.filter(c => c.projectId === pid).length; }

function toggleProjectsSection(e) {
  // Collapse-button click on the + is suppressed via stopPropagation in the
  // header markup, so this only fires for header-body clicks.
  if (e) { e.stopPropagation(); }
  projectsCollapsed = !projectsCollapsed;
  saveProjectsCollapsed();
  renderSidebar();
}

function toggleMobileSection(e) {
  if (e) { e.stopPropagation(); }
  mobileSectionCollapsed = !mobileSectionCollapsed;
  saveMobileSectionCollapsed();
  renderSidebar();
}

function showAllProjectsMenu(e) {
  if (e) { e.stopPropagation(); }
  document.querySelectorAll('.projects-flyout').forEach(m => m.remove());
  const flyout = document.createElement('div');
  flyout.className = 'projects-flyout';
  const sorted = [...projects].sort((a, b) => projectSortKey(b) - projectSortKey(a));
  flyout.innerHTML = sorted.map(p => {
    const count = projectChatsCount(p.id);
    return `<div class="projects-flyout-item" onclick="openProjectFromFlyout('${esc(p.id)}',event)">`
      + `<span class="projects-flyout-name">${esc(p.name)}</span>`
      + (count ? `<span class="projects-flyout-count">${count}</span>` : '')
      + `</div>`;
  }).join('') || '<div class="projects-flyout-empty">No projects</div>';
  // Anchor to the clicked More button: align top, push horizontally past the sidebar.
  const anchor = e?.target?.closest('.project-more');
  document.body.appendChild(flyout);
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    const sidebar = document.getElementById('sidebar');
    const sbRight = sidebar ? sidebar.getBoundingClientRect().right : rect.right;
    flyout.style.top = Math.max(8, rect.top) + 'px';
    flyout.style.left = (sbRight + 6) + 'px';
  } else {
    flyout.style.top = '80px';
    flyout.style.left = '260px';
  }
  setTimeout(() => {
    document.addEventListener('click', function h(ev) {
      if (flyout.contains(ev.target)) return;
      flyout.remove();
      document.removeEventListener('click', h);
    });
  }, 10);
}

function openProjectFromFlyout(id, e) {
  if (e) { e.stopPropagation(); }
  document.querySelectorAll('.projects-flyout').forEach(m => m.remove());
  // Expand the project so the user sees its chats, and bump its access time
  // so it surfaces into the top-4 next render.
  if (!expandedProjects.has(id)) expandedProjects.add(id);
  touchProject(id);
  renderSidebar();
  // Scroll the now-visible project into view.
  requestAnimationFrame(() => {
    const items = document.querySelectorAll('#project-list .project-item');
    for (const item of items) {
      if (item.getAttribute('onclick')?.includes(`'${id}'`)) {
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
    }
  });
}

// ── Move-to-project context menu ──
function showMoveMenu(chatId, e) {
  e.stopPropagation();
  document.querySelectorAll('.move-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'move-menu';
  const chat = chats.find(c => c.id === chatId);

  const projectRows = projects.map(p =>
    `<div class="move-menu-item" onclick="moveChat('${esc(chatId)}','${esc(p.id)}',event)">&#128193; ${esc(p.name)}</div>`
  ).join('');

  const removeRow = chat?.projectId ? `<div class="move-menu-item remove" onclick="moveChat('${esc(chatId)}','',event)">Remove from project</div>` : '';

  menu.innerHTML = projectRows + removeRow;
  if (!menu.innerHTML) menu.innerHTML = '<div class="move-menu-item" style="color:var(--muted)">No projects yet</div>';
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
  touchProject(projectId);
  newChat(projectId);
}

function selectChat(id) {
  activeChat = chats.find(c => c.id === id) || null;
  try { window.activeChat = activeChat; } catch {}
  if (activeChat && activeChat.projectId) touchProject(activeChat.projectId);
  renderSidebar();
  try { if (typeof window.updateStatusBar === 'function') window.updateStatusBar(); } catch {}
  navigate('chat');
  // Entry render: land on the latest message (see renderMessages scroll gate).
  window._chatScrollBottomNext = true;
  if (window.renderMessages) renderMessages();
  // Update send/stop button state for THIS chat. Per-session via isStreaming()
  // so switching to a chat that has a stream running (while another stream is
  // also active in a different session) correctly shows its Stop button.
  const isThisChatStreaming = !!(typeof window.isStreaming === 'function' && window.isStreaming(id));
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = isThisChatStreaming ? 'flex' : 'none';
  // Step 4: send-btn always enabled. When this chat is streaming, the
  // sendMessage handler routes the message as an interject into the
  // running turn. When not streaming, normal new-turn flow. The visual
  // mode (inject vs send) + the toolbar STREAMING pill are driven from
  // updateStreamUI() — single source of truth, re-evaluated on store
  // changes via subscribeAll. Call it here on chat-switch so we don't
  // carry stale UI for the previous chat.
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
