// ── App Shell: Sidebar rendering ──
// Pure HTML rendering for the projects/chats list. Reads state from
// app-state.js; called from action handlers and the sync layer whenever
// state changes.

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
        <button class="project-new-chat" onclick="newChatInProject('${p.id}',event)" title="New chat in this project">+</button>
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
