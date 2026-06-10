// ── Chat: Render windowing (entry tail-window + lazy earlier-history) ──
//
// Entry renders of long threads used to build every row — markdown parse +
// syntax highlight per message — which hitched the renderer for seconds on
// chat switch. renderMessages now paints only the last CHAT_WINDOW_SIZE rows;
// a sentinel at the top of the thread loads earlier chunks in place (click,
// or scrolling near the top) with the scroll position preserved.
//
// Window state is chat._renderWindowStart — the messages[] index of the first
// rendered row. Entry renders reset it to the tail; in-place rebuilds keep it
// so expanded history survives a mid-read repaint.
//
// External deps (call time): activeChat (app-state.js), renderMessage /
// _applyPinBottom (chat-render.js — loads after this file; all refs resolve
// at call time).

const CHAT_WINDOW_SIZE = 80;

// Compute + persist the window start for this render. anchor is the live
// streaming row's index (-1 when not streaming); the window must always
// include it so the renderMessages loop can synthesize the live row.
function _resolveWindowStart(chat, isEntry, anchor) {
  const total = chat.messages.length;
  let start = (isEntry || typeof chat._renderWindowStart !== 'number')
    ? Math.max(0, total - CHAT_WINDOW_SIZE)
    : Math.max(0, Math.min(chat._renderWindowStart, total));
  if (anchor >= 0 && anchor < start) start = anchor;
  chat._renderWindowStart = start;
  return start;
}

// Top-of-thread affordance for the hidden rows. Appended by renderMessages
// BEFORE the message loop, so it sits above the first rendered row.
function _appendEarlierSentinel(el, chat) {
  const hidden = chat._renderWindowStart || 0;
  if (hidden <= 0) return;
  const div = document.createElement('div');
  div.id = 'earlier-sentinel';
  div.style.cssText = 'text-align:center;padding:10px;font-family:var(--mono);font-size:.72rem;color:var(--muted);cursor:pointer;border-bottom:1px dashed var(--border);margin-bottom:12px';
  div.textContent = `↑ Show ${hidden} earlier message${hidden === 1 ? '' : 's'}`;
  div.onclick = () => loadEarlierMessages();
  el.appendChild(div);
  _installEarlierScrollHook(el);
}

// Scrolling near the top loads the next chunk without needing the click.
// Installed once; #messages is never replaced, only its children.
let _earlierScrollHooked = false;
function _installEarlierScrollHook(el) {
  if (_earlierScrollHooked) return;
  _earlierScrollHooked = true;
  el.addEventListener('scroll', () => {
    if (el.scrollTop < 200 && document.getElementById('earlier-sentinel')) loadEarlierMessages();
  }, { passive: true });
}

let _loadingEarlier = false;
function loadEarlierMessages() {
  if (_loadingEarlier) return;
  const el = document.getElementById('messages');
  if (!el || !activeChat || !Array.isArray(activeChat.messages)) return;
  const start = activeChat._renderWindowStart || 0;
  if (start <= 0) return;
  _loadingEarlier = true;
  try {
    const newStart = Math.max(0, start - CHAT_WINDOW_SIZE);
    const sentinel = document.getElementById('earlier-sentinel');
    // First rendered row — the prepend target. renderMessage appends to
    // #messages, so each new node is relocated up here in order.
    const anchorNode = sentinel ? sentinel.nextSibling : el.firstChild;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    for (let i = newStart; i < start; i++) {
      const node = renderMessage(activeChat.messages[i], {});
      if (node && anchorNode) el.insertBefore(node, anchorNode);
    }
    activeChat._renderWindowStart = newStart;
    // addMessageEl migrates pin-bottom onto whatever assistant it just built;
    // re-derive from final DOM order so the true last reply keeps the pin.
    _applyPinBottom(el);
    // Keep the reader anchored on the row they were looking at.
    el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    if (newStart <= 0) {
      if (sentinel) sentinel.remove();
    } else if (sentinel) {
      sentinel.textContent = `↑ Show ${newStart} earlier message${newStart === 1 ? '' : 's'}`;
    }
  } finally {
    _loadingEarlier = false;
  }
}
