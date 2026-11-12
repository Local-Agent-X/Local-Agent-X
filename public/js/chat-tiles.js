// ── Chat tiles: several chats side by side ──
//
// The chat page as a grid of two to eight chats (ADR 0007 §6). The chat on
// screen stays exactly what it is (#chat-main: its input box, model picker,
// approvals); the other tiled chats are live views beside it (.chat-tile,
// chat-tiles-view.js). Clicking a view opens that chat the way the sidebar
// does (selectChat), and the grid puts #chat-main in that pane's place, so
// nothing is drawn twice and there is still one current chat and one socket.
//
// #chat-main never moves in the document: #chat-tiles wraps it, is
// `display:contents` when tiles are off (the page lays out as it always did)
// and a CSS grid when on, where `order` places the panes.
//
// A live view needs what the chat on screen gets for free:
//   - the chat's events: the socket follows a set of chats, so each tiled chat
//     is subscribed (and again when the socket reconnects);
//   - its saved messages: a turn this page did not send is never written into
//     chat.messages here, so the chat is re-read when its turn starts (for the
//     prompt) and when it ends (for the reply).
//
// Which chats are tiled, and in what order, is remembered per project (or
// collab), in this browser. A pane is moved by dragging its head onto another
// (chat-tiles-drag.js).
//
// Panes are offered where they share something. Code sessions (the sidebar's
// code side, sidebar-mode.js) share a project folder: the Tiles button shows
// on one and only code sessions are its panes. The chats of a collab
// (chat-collab.js) share a question: the grid holds exactly those. Any other
// chat on screen puts the grid away until a chat that tiles is opened again.
//
// External deps: ChatTilesCore (chat-tiles-core.js); chatTileEl, paintChatTile,
// paintChatTileHead (chat-tiles-view.js); chats, selectChat, newChat
// (app-state.js, app-sidebar-actions.js); chatModeOf (sidebar-mode.js);
// hydrateChat (app-sync.js); laxCollab (chat-collab.js); ChatTilesDrag
// (chat-tiles-drag.js); laxAppMessage (chat-app-message.js);
// ChatStreamStore; apiFetch (shared.js); orchestratorState, otherAgentsRows
// (chat-agent-feeds-claims.js).

var laxChatTiles = (function () {
  var STORE_KEY = 'lax_chat_tiles_v1';
  var VIEW_ROWS = 20;
  var REREAD_RETRY_MS = 1500;
  var on = false;
  var ids = [];
  var focusedId = '';
  var addNext = false;
  var shownKey = '';
  var models = {};
  var lastStatus = {};
  var keepReply = {};
  var paintQueued = {};

  function active() { try { return window.activeChat || null; } catch (e) { return null; } }
  function chatOf(id) { return (typeof chats !== 'undefined' && Array.isArray(chats) ? chats : []).find(function (c) { return c.id === id; }) || null; }
  function isCode(c) { return !!c && chatModeOf(c) === 'code'; }
  /** The collab `c` is part of ({id, chatIds}), or null. */
  function collabOf(c) { try { return (c && window.laxCollab && window.laxCollab.of(c.id)) || null; } catch (e) { return null; } }
  function tileable(c) { return isCode(c) || !!collabOf(c); }
  /** What the panes beside `a` share: its collab, or the code side. */
  function groupKey(a) { var g = collabOf(a); return g ? g.id : 'code'; }
  function projectKey() { var a = active(); var g = collabOf(a); return g ? g.id : (a && a.projectId) || 'none'; }
  /** The chats that can be panes beside the chat on screen: its collab's, else the code sessions. */
  function pool() {
    var all = typeof chats !== 'undefined' && Array.isArray(chats) ? chats : [];
    var g = collabOf(active());
    return g ? all.filter(function (c) { return g.chatIds.indexOf(c.id) !== -1; }) : all.filter(isCode);
  }
  /** The grid is on and the chat on screen is one that tiles. */
  function showing() { return on && tileable(active()); }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save() {
    try {
      var saved = loadSaved();
      saved.on = on;
      saved.byProject = saved.byProject || {};
      if (showing()) saved.byProject[projectKey()] = ids;
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (e) { /* private mode or a full store: the grid still works, unremembered */ }
  }

  function orchestratorId() {
    var state = typeof orchestratorState !== 'undefined' ? orchestratorState : null;
    if (!state) return '';
    return state.mine ? focusedId : (state.heldBySession || '');
  }
  function clashes(id) {
    var rows = typeof otherAgentsRows !== 'undefined' && Array.isArray(otherAgentsRows) ? otherAgentsRows : [];
    return rows.some(function (r) { return r.sessionId === id && r.clashesWithMe; });
  }

  /** The chat's recent messages for a live view: a message the app sent is its
   *  one-line summary there too (chat-app-message.js). */
  function forView(chat) {
    if (!chat || typeof laxAppMessage === 'undefined') return chat;
    return { messages: (chat.messages || []).slice(-3 * VIEW_ROWS).map(function (m) {
      var note = m && m.role === 'user' ? laxAppMessage.summaryOf(m.content) : null;
      return note ? { role: 'user', content: note } : m;
    }) };
  }

  function infoOf(id) {
    var chat = chatOf(id);
    var entry = ChatStreamStore.get(id);
    return {
      title: chat ? chat.title : 'Chat',
      model: models[id] || '',
      state: ChatTilesCore.tileState(entry),
      orchestrator: orchestratorId() === id,
      clash: clashes(id),
      rows: ChatTilesCore.viewRows(forView(chat), entry, VIEW_ROWS, !!keepReply[id]),
    };
  }

  function tileOf(id) {
    var grid = document.getElementById('chat-tiles');
    var tiles = grid ? grid.querySelectorAll('.chat-tile') : [];
    for (var i = 0; i < tiles.length; i++) if (tiles[i].dataset.session === id) return tiles[i];
    return null;
  }

  function paint(id) {
    paintQueued[id] = false;
    if (!showing()) return;
    if (id === focusedId) {
      var head = document.getElementById('chat-tile-head');
      if (head) paintChatTileHead(head, infoOf(id));
      return;
    }
    var el = tileOf(id);
    if (el) paintChatTile(el, infoOf(id));
  }
  function queuePaint(id) {
    if (paintQueued[id]) return;
    paintQueued[id] = true;
    requestAnimationFrame(function () { paint(id); });
  }

  // ── What a live view needs from the server ──

  function follow(id) {
    try {
      if (window.chatWs && window.chatWs.readyState === WebSocket.OPEN) window.chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
    } catch (e) { /* the next connect follows every tile (onSocketOpen) */ }
  }

  /** Re-read a tiled chat's saved messages; once more a moment later when the
   *  turn's messages were not saved yet. */
  function reread(id, retried) {
    var chat = chatOf(id);
    if (!chat || typeof hydrateChat !== 'function') { keepReply[id] = false; return; }
    var before = (chat.messages || []).length;
    chat._needsHydrate = true;
    hydrateChat(chat).catch(function () {}).then(function () {
      if ((chat.messages || []).length === before && !retried && ChatStreamStore.get(id) && !ChatStreamStore.isStreaming(id)) {
        setTimeout(function () { reread(id, true); }, REREAD_RETRY_MS);
        return;
      }
      keepReply[id] = false;
      queuePaint(id);
    });
  }

  function fetchModel(id) {
    if (typeof apiFetch !== 'function') return;
    apiFetch('/api/providers?session=' + encodeURIComponent(id)).then(function (res) {
      return res && res.ok ? res.json() : null;
    }).then(function (data) {
      var cur = data && data.current;
      if (!cur) return;
      models[id] = cur.model || cur.provider || '';
      queuePaint(id);
    }).catch(function () { /* the pane shows no model until the next change */ });
  }

  function onStoreEvent(id, entry) {
    if (!on || ids.indexOf(id) === -1) return;
    var status = entry ? entry.status : 'idle';
    var was = lastStatus[id];
    lastStatus[id] = status;
    if (id !== focusedId && was !== status) {
      // A turn this page sent holds its own rows (liveAnchorIndex >= 0) and
      // saves them itself when it ends; only a turn started elsewhere (the
      // orchestrator, the phone, another window) has to be read back.
      if (status === 'streaming') { if (entry.liveAnchorIndex < 0) reread(id, true); }
      else if (was === 'streaming') { keepReply[id] = !!(entry && entry.content); reread(id, false); }
    }
    queuePaint(id);
  }

  // ── The grid ──

  function watch(id) {
    follow(id);
    var chat = chatOf(id);
    if (chat && chat._needsHydrate && id !== focusedId && !ChatStreamStore.isActive(id)) reread(id, true);
    if (!(id in models)) { models[id] = ''; fetchModel(id); }
    var entry = ChatStreamStore.get(id);
    lastStatus[id] = entry ? entry.status : 'idle';
  }

  function layout() {
    var grid = document.getElementById('chat-tiles');
    var main = document.getElementById('chat-main');
    if (!grid || !main) return;
    var a = active();
    var show = showing();
    // Any other chat on screen leaves the panes, and the one it would return to, as they were.
    if (show) { ids = ChatTilesCore.pruned(ids, pool()); focusedId = a.id; }
    document.body.classList.toggle('chat-tiles-on', show);
    var toggle = document.getElementById('chat-tiles-toggle');
    if (toggle) { toggle.classList.toggle('on', show); toggle.style.display = tileable(a) ? '' : 'none'; }
    var addBtn = document.getElementById('chat-tiles-add');
    // A collab's panes are its chats: the button is there to bring back one that was closed.
    var roomToAdd = ids.length < ChatTilesCore.MAX_TILES && (!collabOf(a) || ChatTilesCore.addable(pool(), ids, 1).length > 0);
    if (addBtn) { addBtn.style.display = show && roomToAdd ? '' : 'none'; addBtn.textContent = collabOf(a) ? '+ Chat' : '+ Session'; }
    Array.prototype.slice.call(grid.querySelectorAll('.chat-tile')).forEach(function (el) {
      if (!show || ids.indexOf(el.dataset.session) === -1) el.remove();
    });
    main.style.order = '';
    grid.style.removeProperty('--tile-cols');
    grid.style.removeProperty('--tile-rows');
    if (!show) { closeAddMenu(); return; }
    var shape = ChatTilesCore.gridShape(ids.length);
    grid.style.setProperty('--tile-cols', String(shape.cols));
    grid.style.setProperty('--tile-rows', String(shape.rows));
    ids.forEach(function (id, i) {
      var el = tileOf(id);
      if (!el) { el = chatTileEl(id); grid.appendChild(el); watch(id); }
      el.style.order = String(i);
      el.hidden = id === focusedId;
      if (id === focusedId) main.style.order = String(i);
      paint(id);
    });
    if (ids.indexOf(focusedId) === -1) main.style.order = String(ids.length);
    save();
  }

  /** The panes the grid opens with: the ones remembered for this project or
   *  collab, else the collab's chats or the project's code sessions. */
  function fill() {
    var remembered = ChatTilesCore.pruned((loadSaved().byProject || {})[projectKey()] || [], pool());
    var a = active();
    var g = collabOf(a);
    shownKey = groupKey(a);
    ids = remembered.length > 1 ? ChatTilesCore.withChat(remembered, remembered[0], a && a.id)
      : g ? ChatTilesCore.pruned(g.chatIds, pool())
      : ChatTilesCore.projectChats(pool(), a);
  }

  function toggle() {
    if (!on && !tileable(active())) return;
    on = !on;
    if (on) fill();
    layout();
    save();
  }

  /** The chat on screen changed (selectChat, newChat, deleteChat). */
  function onChatChanged() {
    var a = active();
    if (!on || (a && !tileable(a))) { layout(); return; }
    // From a code session to a collab's chat, or back: the other group's panes.
    if (a && ids.length && groupKey(a) !== shownKey) { fill(); addNext = false; layout(); return; }
    if (!a) {
      ids = ChatTilesCore.pruned(ids, pool());
      if (ids.length && typeof selectChat === 'function') { selectChat(ids[0]); return; }
    } else if (!ids.length) {
      fill();
    } else if (addNext) {
      ids = ChatTilesCore.added(ids, a.id);
      if (ids.indexOf(a.id) === -1) ids = ChatTilesCore.withChat(ids, focusedId, a.id);
    } else {
      ids = ChatTilesCore.withChat(ids, focusedId, a.id);
    }
    addNext = false;
    layout();
  }

  function close(id) {
    ids = ChatTilesCore.without(ids, id);
    delete keepReply[id];
    if (ids.length === 0) { on = false; layout(); save(); return; }
    if (id === focusedId && typeof selectChat === 'function') { selectChat(ids[0]); return; }
    layout();
  }

  function add(id) {
    closeAddMenu();
    ids = ChatTilesCore.added(ids, id);
    layout();
  }
  function addProject() {
    closeAddMenu();
    ChatTilesCore.projectChats(pool(), active()).forEach(function (id) { ids = ChatTilesCore.added(ids, id); });
    layout();
  }
  function addNew() {
    closeAddMenu();
    var a = active();
    addNext = true;
    if (typeof newChat === 'function') newChat(a && a.projectId ? a.projectId : undefined, 'code');
  }

  // ── The "+ Chat" menu ──

  function closeAddMenu() {
    var menu = document.getElementById('chat-tiles-menu');
    if (menu) menu.remove();
  }
  function menuItem(label, run) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-tiles-menu-item';
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  }
  function openAddMenu() {
    if (document.getElementById('chat-tiles-menu')) { closeAddMenu(); return; }
    var anchor = document.getElementById('chat-tiles-add');
    if (!anchor) return;
    var menu = document.createElement('div');
    menu.id = 'chat-tiles-menu';
    menu.className = 'chat-tiles-menu';
    var a = active();
    if (collabOf(a)) {
      menu.appendChild(menuItem('All chats of this collab', function () { pool().forEach(function (c) { add(c.id); }); }));
    } else {
      if (a && a.projectId) menu.appendChild(menuItem('All sessions in this project', addProject));
      menu.appendChild(menuItem('New session', addNew));
    }
    ChatTilesCore.addable(pool(), ids, 12).forEach(function (c) {
      menu.appendChild(menuItem(c.title || 'Session', function () { add(c.id); }));
    });
    var box = anchor.getBoundingClientRect();
    menu.style.top = (box.bottom + 4) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - box.right) + 'px';
    document.body.appendChild(menu);
  }

  function onGridClick(e) {
    var tile = e.target && e.target.closest ? e.target.closest('.chat-tile') : null;
    if (!tile) return;
    if (e.target.closest('.chat-tile-close')) { e.stopPropagation(); close(tile.dataset.session); return; }
    if (typeof selectChat === 'function') selectChat(tile.dataset.session);
  }

  function init() {
    var grid = document.getElementById('chat-tiles');
    if (!grid) return;
    grid.addEventListener('click', onGridClick);
    grid.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('chat-tile')) { e.preventDefault(); onGridClick(e); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest || (!e.target.closest('#chat-tiles-menu') && !e.target.closest('#chat-tiles-add'))) closeAddMenu();
    });
    ChatTilesDrag.wire(grid, function () { return focusedId; }, function (from, to) { ids = ChatTilesCore.moved(ids, from, to); layout(); });
    ChatStreamStore.subscribeAll(onStoreEvent);
    // The chat list and the chat on screen are restored after this script
    // runs: the Tiles button shows, and a grid left on comes back, with the
    // first chat that opens (at once on a code session, else on the next one).
    var restore = setInterval(function () {
      if (!active()) return;
      clearInterval(restore);
      if (!on && loadSaved().on) { on = true; if (tileable(active())) fill(); }
      layout();
    }, 300);
    setTimeout(function () { clearInterval(restore); }, 15000);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return {
    toggle: toggle, openAddMenu: openAddMenu, onChatChanged: onChatChanged, closeFocused: function () { close(focusedId); },
    onSocketOpen: function () { if (on) ids.forEach(follow); },
    onModelChanged: function (id) { if (on && ids.indexOf(id) !== -1) fetchModel(id); },
    onClaimsChanged: function () { if (on) ids.forEach(queuePaint); },
    /** Show the chat on screen with the rest of its group (a collab just started). */
    showGroup: function () { if (!tileable(active())) return; on = true; fill(); layout(); save(); },
    isOn: function () { return on; }, tiles: function () { return ids.slice(); },
  };
})();
