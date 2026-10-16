// ── Notification Center: the view of the user inbox (src/inbox/) ──
//
// The list is the server's (GET /api/inbox), shared by every tab and device:
// an agent asking for the user, a background or scheduled job's outcome, a
// call an unattended run parked for the user's yes (an "approval": Approve
// runs that exact call once, Decline skips it, POST /api/inbox/act), an
// available update. Items that need the user are pinned on top. The server
// pushes `inbox_item` when one arrives (an approved call's outcome arrives
// that way) and `inbox_changed` after any tab answers one (chat-ws-handler.js
// routes both here); chat-ws.js reloads the list on every (re)connect.
//
// An approval's body is its confirmation: it names the job, the tool, what the
// call does and why it needed the user, so Approve asks nothing further, the
// same as the approval card in a chat.
//
// addNotification() is the one tab-local producer: a UI action in this tab
// that failed (an agent redirect not delivered). It renders through the same
// list as an "app-error" item but is never sent to the server: it concerns
// this tab only, and the server being unreachable is one of its causes.
//
// External deps (classic-script globals): apiFetch (shared-api.js), esc
// (shared-escape.js), Spring, navigate, selectChat, chats, openSettings.

var _inboxItems = [];
var _inboxLocal = [];
var _inboxUnread = 0;
var MAX_LOCAL_ITEMS = 20;
var INBOX_KIND_LABEL = {
  'agent-message': 'Agent', job: 'Job', update: 'Update', 'app-error': 'Error', approval: 'Needs your OK',
};
var INBOX_RESOLUTION_LABEL = { approved: 'Approved', declined: 'Declined', failed: 'Approved, could not run' };
var _inboxAnswering = {};

function addNotification(text, type) {
  _inboxLocal.unshift({
    id: 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'app-error', title: String(text || ''), body: '', createdAt: Date.now(),
    needsYou: false, _local: true, _type: type || 'info',
  });
  if (_inboxLocal.length > MAX_LOCAL_ITEMS) _inboxLocal.pop();
  renderNotifications();
  updateNotifBadge();
}

async function loadInbox() {
  try {
    var r = await apiFetch('/api/inbox');
    if (!r.ok) return;
    var data = await r.json();
    _inboxItems = Array.isArray(data.items) ? data.items : [];
    _inboxUnread = typeof data.unread === 'number' ? data.unread : 0;
    renderNotifications();
    updateNotifBadge();
  } catch (e) { console.warn('[inbox] load failed', e && e.message); }
}

function handleInboxFrame(msg) {
  if (msg.type === 'inbox_changed') { loadInbox(); return; }
  if (msg.type !== 'inbox_item' || !msg.item || !msg.item.id) return;
  var item = msg.item;
  _inboxItems = _inboxItems.filter(function (n) { return n.id !== item.id; });
  _inboxItems.unshift(item);
  if (typeof msg.unread === 'number') _inboxUnread = msg.unread;
  renderNotifications();
  updateNotifBadge();
  if (item.needsYou && !item.resolvedAt && window.desktop && typeof window.desktop.showNotification === 'function') {
    window.desktop.showNotification(item.title, String(item.body || '').slice(0, 100));
  }
}

function inboxIsPinned(n) { return !!n.needsYou && !n.resolvedAt; }

function inboxSorted() {
  var at = function (n) { return n.updatedAt || n.createdAt || 0; };
  return _inboxItems.concat(_inboxLocal).sort(function (a, b) {
    return (inboxIsPinned(b) - inboxIsPinned(a)) || (at(b) - at(a));
  });
}

function inboxClip(text, max) {
  var s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// An open approval is answered only by Approve or Decline, so it offers no
// Done or Dismiss: either would close it without an answer.
function renderInboxItem(n) {
  var pinned = inboxIsPinned(n);
  var unread = !n.readAt;
  var awaiting = n.kind === 'approval' && pinned;
  var answering = !!_inboxAnswering[n.id];
  var cls = 'notif-item' + (pinned ? ' needs-you' : '') + (unread ? ' unread' : '') + (n.resolvedAt ? ' resolved' : '');
  var actions = (Array.isArray(n.actions) ? n.actions : []).map(function (a) {
    if (!awaiting) return n.kind === 'approval' ? '' : '<button type="button" class="notif-btn" disabled title="Not available yet">' + esc(a.label) + '</button>';
    return '<button type="button" class="notif-btn" data-inbox-answer="' + esc(a.id) + '"' + (answering ? ' disabled' : '') + '>' + esc(a.label) + '</button>';
  }).join('');
  var state = answering ? 'Running…' : (n.resolution ? INBOX_RESOLUTION_LABEL[n.resolution] || n.resolution : '');
  return '<div class="' + cls + '" data-inbox-id="' + esc(n.id) + '">'
    + '<div class="notif-meta"><span class="notif-kind">' + esc(INBOX_KIND_LABEL[n.kind] || n.kind) + '</span>'
    + '<span class="notif-time">' + esc(timeAgo(n.updatedAt || n.createdAt)) + '</span></div>'
    + '<div class="notif-title">' + esc(n.title) + '</div>'
    + (n.body ? '<div class="notif-body">' + esc(n.kind === 'approval' ? n.body : inboxClip(n.body, 400)) + '</div>' : '')
    + '<div class="notif-actions">' + actions
    + (state ? '<span class="notif-resolution">' + esc(state) + '</span>' : '')
    + (pinned && !awaiting ? '<button type="button" class="notif-btn" data-inbox-act="resolve">Done</button>' : '')
    + (unread ? '<button type="button" class="notif-btn" data-inbox-act="read">Mark read</button>' : '')
    + (awaiting ? '' : '<button type="button" class="notif-btn" data-inbox-act="dismiss">Dismiss</button>')
    + '</div></div>';
}

function renderNotifications() {
  var el = document.getElementById('notif-list');
  if (!el) return;
  bindInboxList(el);
  var items = inboxSorted();
  el.innerHTML = items.length === 0
    ? '<div class="notif-empty">No notifications yet</div>'
    : items.map(renderInboxItem).join('');
}

function updateNotifBadge() {
  var badge = document.getElementById('notif-badge');
  var count = _inboxUnread + _inboxLocal.filter(function (n) { return !n.readAt; }).length;
  if (badge) {
    badge.textContent = count > 0 ? String(count) : '';
    badge.style.display = count > 0 ? '' : 'none';
  }
}

function findInboxItem(id) {
  return _inboxItems.concat(_inboxLocal).find(function (n) { return n.id === id; }) || null;
}

async function inboxAct(id, act) {
  var local = _inboxLocal.find(function (n) { return n.id === id; });
  if (local) {
    if (act === 'dismiss') _inboxLocal = _inboxLocal.filter(function (n) { return n.id !== id; });
    else local.readAt = Date.now();
    renderNotifications();
    updateNotifBadge();
    return;
  }
  try {
    var r = await apiFetch('/api/inbox/' + act, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id: id } : {}),
    });
    if (!r.ok) console.warn('[inbox] ' + act + ' refused: ' + r.status);
  } catch (e) { console.warn('[inbox] ' + act + ' failed', e && e.message); }
  loadInbox();
}

// The server claims the item before anything runs, so a second click (here or
// in another tab) gets 409 and runs nothing; disabling the buttons only spares
// the round trip. The outcome arrives as its own item (an inbox_item frame).
async function answerInboxApproval(id, action) {
  if (_inboxAnswering[id]) return;
  _inboxAnswering[id] = true;
  renderNotifications();
  try {
    var r = await apiFetch('/api/inbox/act', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, action: action }),
    });
    if (!r.ok) console.warn('[inbox] ' + action + ' refused: ' + r.status);
  } catch (e) { console.warn('[inbox] ' + action + ' failed', e && e.message); }
  delete _inboxAnswering[id];
  loadInbox();
}

function markAllInboxRead() {
  _inboxLocal.forEach(function (n) { if (!n.readAt) n.readAt = Date.now(); });
  inboxAct('', 'read-all');
}

// Where an item leads. Agent and issue views live on the Agents page (its
// module sets the window.* openers); a scheduled run's session is hidden from
// the chat list, so it opens Missions instead.
function openInboxLink(n) {
  var link = n.link || {};
  var call = function (name, arg) { if (typeof window[name] === 'function') window[name](arg); };
  if (n.kind === 'update') { if (typeof openSettings === 'function') openSettings('general'); return; }
  if (link.issueId || link.agentId) {
    navigate('agents');
    if (link.issueId) call('showIssueDetail', link.issueId);
    else call(n.kind === 'agent-message' ? 'showHiredAgent' : 'showAgentDetail', link.agentId);
    return;
  }
  if (link.sessionId) {
    if (link.sessionId.indexOf('cron-') === 0) { navigate('missions'); return; }
    var known = typeof chats !== 'undefined' && Array.isArray(chats) && chats.some(function (c) { return c.id === link.sessionId; });
    if (known && typeof selectChat === 'function') selectChat(link.sessionId);
  }
}

function bindInboxList(el) {
  if (el._inboxBound) return;
  el._inboxBound = true;
  el.addEventListener('click', function (ev) {
    var row = ev.target.closest && ev.target.closest('[data-inbox-id]');
    if (!row) return;
    var id = row.getAttribute('data-inbox-id');
    var answer = ev.target.closest('[data-inbox-answer]');
    if (answer) { ev.stopPropagation(); answerInboxApproval(id, answer.getAttribute('data-inbox-answer')); return; }
    var btn = ev.target.closest('[data-inbox-act]');
    if (btn) { ev.stopPropagation(); inboxAct(id, btn.getAttribute('data-inbox-act')); return; }
    if (ev.target.closest('button')) return;
    var n = findInboxItem(id);
    if (!n) return;
    if (!n.readAt) inboxAct(id, 'read');
    if (n.link || n.kind === 'update') { toggleNotifPanel(); openInboxLink(n); }
  });
}

function toggleNotifPanel() {
  var panel = document.getElementById('notif-panel');
  if (!panel) return;
  var opening = !panel.classList.contains('open');
  if (opening) {
    panel.classList.add('open');
    // Disable CSS transition, let spring handle it
    panel.style.transition = 'none';
    Spring.animate(panel, 'x', 0, { from: 320, preset: 'stiff', unit: 'px', onDone: function () { panel.style.transition = ''; panel.style.transform = ''; } });
    renderNotifications();
    // An item posted from an out-of-process worker has no live frame here.
    loadInbox();
  } else {
    panel.style.transition = 'none';
    Spring.animate(panel, 'x', 320, { from: 0, preset: 'stiff', unit: 'px', onDone: function () { panel.classList.remove('open'); panel.style.transform = ''; panel.style.transition = ''; } });
  }
}

function timeAgo(ts) {
  var diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// The list used to live in this window's localStorage; the server owns it now.
try { localStorage.removeItem('lax_notifications'); } catch (e) { /* storage unavailable: nothing to clear */ }
updateNotifBadge();

// Getting Started checklist removed 2026-05-17. Took sidebar real estate
// without earning it: "Hire your first agent" / "Try a protocol" boxes
// were filler that didn't help anyone discover features, and the
// "provider" check pre-checked based on stale localStorage signals
// that misled fresh users about their actual state. Users learn the
// app by clicking around — the onboarding wizard at first launch
// already handles the only step that actually matters (connect a
// provider). Anything else is discoverable in-product.
