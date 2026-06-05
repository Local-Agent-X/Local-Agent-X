// ── Notification Center ──

let _notifications = [];
try { _notifications = JSON.parse(localStorage.getItem('lax_notifications') || '[]'); } catch {}

function addNotification(text, type) {
  type = type || 'info';
  _notifications.unshift({ text, type, time: Date.now(), read: false });
  if (_notifications.length > 50) _notifications.pop();
  localStorage.setItem('lax_notifications', JSON.stringify(_notifications));
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
    return `<div class="notif-item" style="opacity:${n.read ? '.5' : '1'}" onclick="_notifications[${i}].read=true;localStorage.setItem('lax_notifications',JSON.stringify(_notifications));renderNotifications();updateNotifBadge()">
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
  if (!panel) return;
  const opening = !panel.classList.contains('open');
  if (opening) {
    panel.classList.add('open');
    // Disable CSS transition, let spring handle it
    panel.style.transition = 'none';
    Spring.animate(panel, 'x', 0, { from: 320, preset: 'stiff', unit: 'px', onDone: () => { panel.style.transition = ''; panel.style.transform = ''; } });
    renderNotifications();
  } else {
    panel.style.transition = 'none';
    Spring.animate(panel, 'x', 320, { from: 0, preset: 'stiff', unit: 'px', onDone: () => { panel.classList.remove('open'); panel.style.transform = ''; panel.style.transition = ''; } });
  }
}

function clearNotifications() {
  _notifications = [];
  localStorage.setItem('lax_notifications', '[]');
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

// Getting Started checklist removed 2026-05-17. Took sidebar real estate
// without earning it: "Hire your first agent" / "Try a protocol" boxes
// were filler that didn't help anyone discover features, and the
// "provider" check pre-checked based on stale localStorage signals
// that misled fresh users about their actual state. Users learn the
// app by clicking around — the onboarding wizard at first launch
// already handles the only step that actually matters (connect a
// provider). Anything else is discoverable in-product.
