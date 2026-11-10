// ── Chat tiles: one live view ──
//
// The pane of a tiled chat that is NOT the chat on screen (chat-tiles.js): its
// name, model and state, its recent messages and the reply as it is written.
// Plain text only: a click opens the chat in full, where cards, approvals and
// rendered markdown live. Text goes in with textContent, never as markup.
//
// chatTileEl(id) builds the pane; paintChatTile(el, info) fills it:
//   info = { title, model, state, orchestrator, clash, rows }
// with `state` and `rows` from ChatTilesCore (tileState, viewRows).

var CHAT_TILE_STATE_LABEL = { 'needs-you': 'Needs you', working: 'Working', idle: '' };

function chatTileSpan(cls, text) {
  var el = document.createElement('span');
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function chatTileEl(sessionId) {
  var el = document.createElement('div');
  el.className = 'chat-tile';
  el.dataset.session = sessionId;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  var head = document.createElement('div');
  head.className = 'chat-tile-head';
  head.appendChild(chatTileSpan('chat-tile-dot'));
  head.appendChild(chatTileSpan('chat-tile-title'));
  head.appendChild(chatTileSpan('chat-tile-orch'));
  head.appendChild(chatTileSpan('chat-tile-clash'));
  head.appendChild(chatTileSpan('chat-tile-state'));
  head.appendChild(chatTileSpan('chat-tile-model'));
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'chat-tile-close';
  close.title = 'Close this pane (the chat keeps running)';
  close.setAttribute('aria-label', 'Close this pane');
  close.textContent = '×';
  head.appendChild(close);
  var body = document.createElement('div');
  body.className = 'chat-tile-body';
  el.appendChild(head);
  el.appendChild(body);
  return el;
}

function chatTileRowEl(row) {
  var el = document.createElement('div');
  el.className = 'chat-tile-row ' + row.role + (row.live ? ' live' : '');
  if (row.text) {
    var text = document.createElement('div');
    text.className = 'chat-tile-text';
    text.textContent = row.text;
    el.appendChild(text);
  }
  if (row.live && (row.tool || !row.text)) {
    var tool = document.createElement('div');
    tool.className = 'chat-tile-tool';
    tool.textContent = row.tool ? 'Running ' + row.tool + '…' : 'Thinking…';
    el.appendChild(tool);
  }
  return el;
}

/** The header of a pane: also used for the bar above the chat on screen. */
function paintChatTileHead(head, info) {
  var set = function (cls, text, title) {
    var el = head.querySelector('.' + cls);
    if (!el) return;
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
    if (title) el.title = title;
  };
  set('chat-tile-title', info.title || 'Chat');
  set('chat-tile-orch', info.orchestrator ? '◈ Orchestrator' : '', 'This chat hands out the work in this project.');
  set('chat-tile-clash', info.clash ? '⚠' : '', 'Changing the same files as the chat on screen');
  set('chat-tile-state', CHAT_TILE_STATE_LABEL[info.state] || '');
  set('chat-tile-model', info.model || '');
}

function paintChatTile(el, info) {
  el.className = 'chat-tile ' + info.state;
  el.setAttribute('aria-label', 'Open ' + (info.title || 'chat'));
  paintChatTileHead(el.querySelector('.chat-tile-head'), info);
  var body = el.querySelector('.chat-tile-body');
  // Follow the newest text unless the reader scrolled up in this pane.
  var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  var rows = info.rows || [];
  // The saved rows change once a turn; the reply being written changes many
  // times a second. Rebuild the saved rows only when they changed.
  var saved = rows.filter(function (r) { return !r.live; });
  var last = saved[saved.length - 1];
  var key = saved.length + '|' + (last ? last.role + last.text.length : '');
  if (body.dataset.saved !== key) {
    body.textContent = '';
    saved.forEach(function (r) { body.appendChild(chatTileRowEl(r)); });
    body.dataset.saved = key;
  }
  var oldLive = body.querySelector('.chat-tile-row.live');
  if (oldLive) oldLive.remove();
  var live = rows[rows.length - 1];
  if (live && live.live) body.appendChild(chatTileRowEl(live));
  if (!body.firstChild) {
    var empty = document.createElement('div');
    empty.className = 'chat-tile-empty';
    empty.textContent = 'No messages yet.';
    body.appendChild(empty);
    body.dataset.saved = '';
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
}
