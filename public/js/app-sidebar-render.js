// ── App Shell: Sidebar rendering ──
// Pure HTML rendering for the projects/chats list. Reads state from
// app-state.js; called from action handlers and the sync layer whenever
// state changes.

const PROJECTS_VISIBLE_LIMIT = 4;

function projectSortKey(p) {
  // Last-accessed first, then fall back to project's own updatedAt/createdAt
  // so projects with no recorded access still have a stable order.
  return projectLastAccessed[p.id] || p.updatedAt || p.createdAt || 0;
}

function renderProjectRow(p) {
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
}

function renderProjects() {
  const section = document.getElementById('projects-section');
  if (section) section.classList.toggle('collapsed', !!projectsCollapsed);
  const chevron = section?.querySelector('.projects-chevron');
  if (chevron) chevron.innerHTML = projectsCollapsed ? '&#9656;' : '&#9662;';

  const el = document.getElementById('project-list');
  if (!el) return;
  if (projectsCollapsed) { el.innerHTML = ''; return; }
  if (projects.length === 0) {
    el.innerHTML = '<div style="padding:4px 12px;font-size:.72rem;color:var(--muted)">No projects yet</div>';
    return;
  }
  const sorted = [...projects].sort((a, b) => projectSortKey(b) - projectSortKey(a));
  const visible = sorted.slice(0, PROJECTS_VISIBLE_LIMIT);
  const hiddenCount = Math.max(0, sorted.length - visible.length);
  const moreBtn = hiddenCount > 0
    ? `<div class="project-more" onclick="showAllProjectsMenu(event)">&#8943; More (${hiddenCount})</div>`
    : '';
  el.innerHTML = visible.map(renderProjectRow).join('') + moreBtn;
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
    return `
    <div class="chat-item ${activeChat && activeChat.id === c.id ? 'active' : ''}${isPinned ? ' pinned' : ''}" onclick="selectChat('${c.id}')" role="option" aria-selected="${activeChat && activeChat.id === c.id}">
      <span class="chat-dot${typeof isChatActive==='function'&&isChatActive(c.id)?' active-pulse':''}"></span>
      <span class="chat-title">${isPinned ? '<span class="pin-icon" title="Pinned">&#128204;</span> ' : ''}${esc(c.title)}</span>
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

  // Mobile wrapper: hide entirely when both subsections are empty; otherwise
  // honor the persisted collapse state. Body display toggles inside the wrapper.
  const mobileSection = document.getElementById('mobile-section');
  const mobileBody = document.getElementById('mobile-body');
  if (mobileSection) {
    const hasAny = waChats.length > 0 || tgChats.length > 0;
    mobileSection.style.display = hasAny ? '' : 'none';
    mobileSection.classList.toggle('collapsed', !!mobileSectionCollapsed);
    const chev = mobileSection.querySelector('.mobile-chevron');
    if (chev) chev.innerHTML = mobileSectionCollapsed ? '&#9656;' : '&#9662;';
    if (mobileBody) mobileBody.style.display = mobileSectionCollapsed ? 'none' : '';
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

  let html = '';
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
    const isOpen = localStorage.getItem('lax_archived_open') === '1';
    html += `<div class="chat-group-label" style="cursor:pointer;user-select:none" onclick="toggleArchivedSection()">${isOpen ? '&#9662;' : '&#9656;'} Archived (${archivedChats.length})</div>`;
    if (isOpen) {
      html += archivedChats.map(renderItem).join('');
    }
  }

  el.innerHTML = html || '<div style="padding:8px 12px;font-size:.72rem;color:var(--muted)">No chats yet. Click + New Chat.</div>';
}

function toggleArchivedSection() {
  const open = localStorage.getItem('lax_archived_open') === '1';
  localStorage.setItem('lax_archived_open', open ? '0' : '1');
  renderChatList();
}

function renderSidebar() {
  renderProjects();
  renderChatList();
}
