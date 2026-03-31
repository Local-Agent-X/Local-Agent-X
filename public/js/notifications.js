// ── Notification Center ──

let _notifications = [];
try { _notifications = JSON.parse(localStorage.getItem('sax_notifications') || '[]'); } catch {}

function addNotification(text, type) {
  type = type || 'info';
  _notifications.unshift({ text, type, time: Date.now(), read: false });
  if (_notifications.length > 50) _notifications.pop();
  localStorage.setItem('sax_notifications', JSON.stringify(_notifications));
  renderNotifications();
  updateNotifBadge();
}

function renderNotifications() {
  const el = document.getElementById('notif-list');
  if (!el) return;
  if (_notifications.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:.75rem">No notifications yet</div>';
    return;
  }
  el.innerHTML = _notifications.map((n, i) => {
    const ago = timeAgo(n.time);
    const color = n.type === 'error' ? 'var(--danger)' : n.type === 'success' ? 'var(--accent)' : 'var(--text)';
    return `<div class="notif-item" style="opacity:${n.read ? '.5' : '1'}" onclick="_notifications[${i}].read=true;localStorage.setItem('sax_notifications',JSON.stringify(_notifications));renderNotifications();updateNotifBadge()">
      <div style="color:${color}">${esc(n.text)}</div>
      <div class="notif-time">${ago}</div>
    </div>`;
  }).join('');
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const count = _notifications.filter(n => !n.read).length;
  if (badge) {
    badge.textContent = count > 0 ? count : '';
    badge.style.display = count > 0 ? '' : 'none';
  }
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (panel) {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) renderNotifications();
  }
}

function clearNotifications() {
  _notifications = [];
  localStorage.setItem('sax_notifications', '[]');
  renderNotifications();
  updateNotifBadge();
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// Init
updateNotifBadge();

// ── Getting Started Checklist ──

function checkGettingStarted() {
  if (localStorage.getItem('sax_getting_started_dismissed')) return;
  const checks = [
    { id: 'provider', label: 'Connect an AI provider', done: !!localStorage.getItem('sax_onboarded') },
    { id: 'chat', label: 'Send your first message', done: (typeof chats !== 'undefined' && chats.length > 1) },
    { id: 'agent', label: 'Hire your first agent', done: false },
    { id: 'protocol', label: 'Try a protocol', done: false },
  ];
  // Check agent hire via API
  apiFetch('/api/agents/hired').then(r => r.json()).then(agents => {
    if (Array.isArray(agents) && agents.length > 0) checks[2].done = true;
    showChecklist(checks);
  }).catch(() => showChecklist(checks));
}

function showChecklist(checks) {
  const allDone = checks.every(c => c.done);
  if (allDone) { localStorage.setItem('sax_getting_started_dismissed', '1'); return; }

  const existing = document.getElementById('getting-started');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'getting-started';
  el.style.cssText = 'padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-2)';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:.5px">GETTING STARTED</span>
      <button onclick="this.closest('#getting-started').remove();localStorage.setItem('sax_getting_started_dismissed','1')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.8rem">&times;</button>
    </div>
    ${checks.map(c => `
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:.72rem;color:${c.done ? 'var(--accent)' : 'var(--muted)'}">
        <span>${c.done ? '&#10003;' : '&#9675;'}</span>
        <span style="${c.done ? 'text-decoration:line-through' : ''}">${c.label}</span>
      </div>
    `).join('')}
  `;

  const sidebar = document.getElementById('sidebar');
  const chatsSection = document.getElementById('chats-section');
  if (sidebar && chatsSection) sidebar.insertBefore(el, chatsSection);
}

// Run on load
setTimeout(checkGettingStarted, 1000);
