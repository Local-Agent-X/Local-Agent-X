// ── Chat tiles: the rules, with no page in them ──
//
// Several chats side by side on the chat page (ADR 0007 §6). One of them is
// the chat on screen in full (#chat-main, wherever the grid puts it); the rest
// are live views (chat-tiles-view.js). This file decides which chats are
// tiled, which one a newly opened chat replaces, the shape of the grid, and
// what a live view shows. chat-tiles.js applies it to the page.
//
// No DOM, no globals read: everything is passed in, so it is tested alone.

var ChatTilesCore = (function () {
  var MAX_TILES = 8;
  var ROW_TEXT_MAX = 6000;

  /** Columns and rows for `count` tiles: 2 side by side, then 2x2, 3x2, 4x2. */
  function gridShape(count) {
    var n = Math.max(1, Math.min(MAX_TILES, count));
    var cols = n === 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    return { cols: cols, rows: Math.ceil(n / cols) };
  }

  /** The tiles after `chatId` became the chat on screen. A tiled chat keeps
   *  its place; any other chat takes the place of the one that was on screen,
   *  so opening a chat from the sidebar never reshuffles the grid. */
  function withChat(ids, focusedId, chatId) {
    if (!chatId || ids.indexOf(chatId) !== -1) return ids.slice();
    var at = ids.indexOf(focusedId);
    if (at === -1) return added(ids, chatId);
    var next = ids.slice();
    next[at] = chatId;
    return next;
  }

  /** `ids` with `chatId` in a new tile; unchanged when it is tiled or the grid is full. */
  function added(ids, chatId) {
    if (!chatId || ids.indexOf(chatId) !== -1 || ids.length >= MAX_TILES) return ids.slice();
    return ids.concat([chatId]);
  }

  function without(ids, chatId) {
    return ids.filter(function (id) { return id !== chatId; });
  }

  /** `ids` that are still chats (one may have been deleted or archived). */
  function pruned(ids, chats) {
    var live = {};
    (chats || []).forEach(function (c) { if (c && !c.archived) live[c.id] = true; });
    return ids.filter(function (id, i) { return live[id] && ids.indexOf(id) === i; }).slice(0, MAX_TILES);
  }

  /** The chats of `active`'s project, the one on screen first, then the most
   *  recently used. A chat in no project tiles alone. */
  function projectChats(chats, active) {
    if (!active) return [];
    var rest = !active.projectId ? [] : (chats || [])
      .filter(function (c) { return c && c.id !== active.id && !c.archived && c.projectId === active.projectId; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return [active].concat(rest).slice(0, MAX_TILES).map(function (c) { return c.id; });
  }

  /** Chats that could be added to the grid, most recently used first. */
  function addable(chats, ids, limit) {
    return (chats || [])
      .filter(function (c) { return c && !c.archived && ids.indexOf(c.id) === -1; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })
      .slice(0, limit);
  }

  /** 'needs-you' (an approval is waiting), 'working', or 'idle'. */
  function tileState(entry) {
    if (!entry) return 'idle';
    if ((entry.approvals || []).some(function (a) { return a && a.status === 'pending'; })) return 'needs-you';
    return entry.status === 'streaming' ? 'working' : 'idle';
  }

  /** The tool a turn is in the middle of, or '' when none is running. */
  function runningTool(entry) {
    var open = [];
    ((entry && entry.toolEvents) || []).forEach(function (te) {
      if (!te) return;
      if (te.type === 'start') open.push(te);
      else if (te.type === 'end') open = open.filter(function (o) { return o.toolCallId !== te.toolCallId; });
    });
    return open.length ? String(open[open.length - 1].name || '') : '';
  }

  function clip(text) {
    var s = String(text == null ? '' : text);
    return s.length > ROW_TEXT_MAX ? '…' + s.slice(s.length - ROW_TEXT_MAX) : s;
  }

  function savedRow(msg) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;
    var text = typeof msg.content === 'string' ? msg.content.trim() : '';
    var tools = (msg._tools && msg._tools.length) || 0;
    if (!text && !tools) return null;
    return { role: msg.role, text: clip(text || 'Used ' + tools + (tools === 1 ? ' tool' : ' tools')), live: false, tool: '' };
  }

  /** What a live view shows: the last `limit` saved messages, then the reply
   *  being written. `keepReply` holds a finished reply on screen until the
   *  chat's saved messages have caught up with it (chat-tiles.js). */
  function viewRows(chat, entry, limit, keepReply) {
    var rows = ((chat && chat.messages) || []).map(savedRow).filter(Boolean).slice(-limit);
    var streaming = !!entry && entry.status === 'streaming';
    if (entry && (streaming || keepReply)) {
      var text = String(entry.content || '').trim();
      var tool = streaming ? runningTool(entry) : '';
      if (text || tool || streaming) rows.push({ role: 'assistant', text: clip(text), live: true, tool: tool });
    }
    return rows;
  }

  return {
    MAX_TILES: MAX_TILES, gridShape: gridShape, withChat: withChat, added: added, without: without,
    pruned: pruned, projectChats: projectChats, addable: addable, tileState: tileState,
    runningTool: runningTool, viewRows: viewRows,
  };
})();
