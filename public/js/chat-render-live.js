// ── Chat: Live in-place updates ──
//
// The incremental DOM paths that avoid renderMessages()'s full #messages wipe.
// Split out of chat-render.js to keep both files under the 400-LOC cap; loads
// AFTER chat-render.js (uses renderMessage / autoScroll / _applyPinBottom from
// it, all resolved at call time). renderMessages() in chat-render.js reads the
// _liveMessageNodes map defined here — runtime-only, so load order is safe.
//
//   - _liveMessageNodes / _rerenderRafs  — per-session live-bubble + rAF state
//   - _swapLiveMessage / rerenderLiveMessage / flushLiveRenders
//                                        — rAF-batched live bubble swap from store
//   - finalizeLiveMessageInPlace         — terminal in-place swap (no thread wipe)
//   - appendMessagesInPlace / insertInjectBubbleInPlace
//                                        — incremental row add / mid-stream inject

// Per-session pointer to the live .msg.assistant DOM node — the bubble that
// rerenderLiveMessage swaps out on each WS event. Populated by the renderMessages
// loop (when it synthesizes the live row) and by rerenderLiveMessage (after swap).
// renderMessages wipes #messages then re-populates inside the loop, so we clear
// at the top.
const _liveMessageNodes = new Map();      // sessionId → .msg.assistant element
// Per-session rAF token so multiple rapid WS events coalesce into one swap
// per frame. The latest store state is read at flush time.
const _rerenderRafs = new Map();          // sessionId → rAF token

// rAF-batched swap of the live assistant bubble from ChatStreamStore state.
// Called from dispatchChatStreamEvent after applyEvent so the bubble always
// reflects the latest store snapshot. Multiple events in one frame coalesce
// into a single swap.
//
// Off-screen sessions, post-done events, and missing live nodes are no-ops —
// renderMessages will catch up on next full render.
// The live bubble is rebuilt from scratch on every WS event, which would
// wipe any block the user manually expanded. Carry the .open state across
// the swap, matching groups/cards by document order (the rebuild is
// deterministic from the same transcript, so new blocks only append).
function preserveOpenState(oldNode, fresh) {
  for (const sel of ['.activity-group', '.tool-card']) {
    const olds = oldNode.querySelectorAll(sel);
    const news = fresh.querySelectorAll(sel);
    for (let i = 0; i < news.length && i < olds.length; i++) {
      if (!olds[i].classList.contains('open')) continue;
      news[i].classList.add('open');
      const chev = news[i].querySelector('.activity-chevron');
      if (chev) chev.textContent = '▼';
    }
  }
}

// The swap also rebuilds .activity-group-body (its own overflow-y scroller),
// which resets scrollTop to 0 — mid-stream that yanked the reader back to the
// first tool call on every WS event. Capture each visible body's position
// before the swap; restore AFTER the fresh node is in the document (scrollTop
// doesn't stick on detached/display:none elements). A reader parked at the
// bottom keeps following new entries as they append.
function captureActivityScroll(oldNode) {
  const saved = [];
  oldNode.querySelectorAll('.activity-group-body').forEach((body, i) => {
    if (!body.clientHeight) return;
    saved.push({
      i,
      top: body.scrollTop,
      atBottom: body.scrollTop + body.clientHeight >= body.scrollHeight - 8,
    });
  });
  return saved;
}

function restoreActivityScroll(fresh, saved) {
  if (!saved.length) return;
  const bodies = fresh.querySelectorAll('.activity-group-body');
  for (const s of saved) {
    const body = bodies[s.i];
    if (body) body.scrollTop = s.atBottom ? body.scrollHeight : s.top;
  }
}

// Synchronous swap of the live bubble from current store state. Returns true
// if it painted. Shared by the rAF-coalesced rerender (foreground) and the
// visibility-flush path (catch-up on refocus). Re-checks conditions itself so
// both callers stay honest — a chat switch / done can land between queue and
// flush.
function _swapLiveMessage(sessionId) {
  if (!activeChat || activeChat.id !== sessionId) return false;
  if (!ChatStreamStore.isStreaming(sessionId)) return false;
  const store = ChatStreamStore.get(sessionId);
  if (!store) return false;
  let oldNode = _liveMessageNodes.get(sessionId);
  if (!oldNode || !document.contains(oldNode)) {
    // Fallback: the manual bubble sendMessage created (before any
    // renderMessages run captured it into _liveMessageNodes).
    const messagesEl = document.getElementById('messages');
    if (messagesEl) {
      const all = messagesEl.querySelectorAll('.msg.assistant');
      oldNode = all[all.length - 1] || null;
    }
  }
  if (!oldNode) return false;
  const tmp = document.createElement('div');
  const fresh = renderMessage(null, { parent: tmp, isLiveSynth: true, store });
  if (!fresh) return false;
  preserveOpenState(oldNode, fresh);
  // Carry the reserved-space class across the swap so the answer keeps
  // streaming into a full viewport of room and the prompt stays pinned.
  if (oldNode.classList.contains('pin-bottom')) fresh.classList.add('pin-bottom');
  const activityScroll = captureActivityScroll(oldNode);
  oldNode.replaceWith(fresh);
  restoreActivityScroll(fresh, activityScroll);
  _liveMessageNodes.set(sessionId, fresh);
  autoScroll();
  return true;
}

function rerenderLiveMessage(sessionId) {
  if (!sessionId) return;
  if (!activeChat || activeChat.id !== sessionId) return;
  if (!ChatStreamStore.isStreaming(sessionId)) return;
  if (_rerenderRafs.has(sessionId)) return;
  const token = requestAnimationFrame(() => {
    _rerenderRafs.delete(sessionId);
    _swapLiveMessage(sessionId);
  });
  _rerenderRafs.set(sessionId, token);
}

// requestAnimationFrame is paused by the browser/Electron while the window is
// backgrounded, minimized, or occluded. Stream deltas still accumulate in
// ChatStreamStore (applyEvent is synchronous), but the live bubble is only
// swapped inside the rAF above — so a backgrounded window shows a frozen "..."
// spinner even though the answer is flowing in. The queued frame eventually
// flushes on refocus, but in the gap it reads as "the agent gave up." Force an
// immediate catch-up paint of the streaming session the moment we're visible
// again, and drop any stale rAF tokens left queued while hidden.
function flushLiveRenders() {
  if (typeof document !== 'undefined' && document.hidden) return;
  for (const sessionId of Array.from(_rerenderRafs.keys())) {
    cancelAnimationFrame(_rerenderRafs.get(sessionId));
    _rerenderRafs.delete(sessionId);
  }
  if (activeChat && ChatStreamStore.isStreaming(activeChat.id)) {
    _swapLiveMessage(activeChat.id);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushLiveRenders();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', flushLiveRenders);
  window.addEventListener('pageshow', flushLiveRenders);
}

// Finalize the live streaming bubble IN PLACE — no #messages wipe. Replaces
// only the one live node with its finalized form (same single-node swap the
// streaming rerender does every frame, so it's visually seamless), instead of
// renderMessages() tearing down and rebuilding the whole thread. The thread
// rebuild is what made every completed turn flash: the smoothly-streamed bubble
// plus every other message vanished and repainted at once. Returns false when
// the live node can't be located so the caller falls back to a full render.
function finalizeLiveMessageInPlace(sessionId, finalizedMsg) {
  const el = document.getElementById('messages');
  if (!el || !finalizedMsg) return false;
  let oldNode = _liveMessageNodes.get(sessionId);
  if (!oldNode || !document.contains(oldNode)) {
    const all = el.querySelectorAll('.msg.assistant');
    oldNode = all[all.length - 1] || null;
  }
  if (!oldNode) return false;
  // Reshape the finalized message (promoteLiveToMessages output) back into the
  // store snapshot _buildLiveAssistantInto reads. Painting from the final
  // content here also covers the post-`done` frame the rAF rerender skips
  // (it bails once isStreaming flips false).
  const store = {
    content: finalizedMsg.content || '',
    toolEvents: finalizedMsg._tools || [],
    chips: finalizedMsg._chips || [],
    progressByTool: finalizedMsg._progressByTool || {},
    approvals: finalizedMsg._approvals || [],
    stopNote: finalizedMsg._stopNote || null,
  };
  const tmp = document.createElement('div');
  const fresh = _buildLiveAssistantInto(tmp, store);
  if (!fresh) return false;
  preserveOpenState(oldNode, fresh);
  const activityScroll = captureActivityScroll(oldNode);
  if (oldNode.classList.contains('pin-bottom')) fresh.classList.add('pin-bottom');
  // Drop the streaming affordance — this is the terminal paint.
  fresh.querySelectorAll('.msg-body.streaming').forEach(b => b.classList.remove('streaming'));
  // A tools-only turn (no text) leaves _buildLiveAssistantInto's "thinking"
  // placeholder in the body; the finalized bubble must not look like it's
  // still working. Matches the full-render output (no dots).
  fresh.querySelectorAll('.msg-body .thinking').forEach(t => t.remove());
  const footer = fresh.querySelector('.msg-footer');
  if (footer && finalizedMsg.timestamp && typeof formatMsgTime === 'function') {
    footer.innerHTML = `<span class="msg-time">${formatMsgTime(finalizedMsg.timestamp)}</span>`;
  }
  oldNode.replaceWith(fresh);
  restoreActivityScroll(fresh, activityScroll);
  _liveMessageNodes.delete(sessionId);
  return true;
}

// ── Incremental thread updates ──
// renderMessages() wipes #messages and re-parses markdown + re-highlights
// code for EVERY row, which on long threads blocks the renderer main thread
// for seconds — the intermittent whole-window freeze. The recurring triggers
// (bg-op nudge, sync hydrate, mid-stream inject, inject_consumed) only ever
// add or restyle a row, so they go through these in-place paths and fall
// back to a full render only when the DOM isn't in a known-good state.

// Append rows for activeChat.messages[fromIndex..] to the existing thread.
// Returns false when an append can't be trusted (container missing,
// empty-state hero showing, index out of range) so the caller falls back
// to renderMessages().
function appendMessagesInPlace(fromIndex) {
  const el = document.getElementById('messages');
  if (!el || !activeChat || !Array.isArray(activeChat.messages)) return false;
  if (document.getElementById('empty')) return false;
  if (fromIndex < 0 || fromIndex >= activeChat.messages.length) return false;
  for (let i = fromIndex; i < activeChat.messages.length; i++) {
    renderMessage(activeChat.messages[i], {});
  }
  _applyPinBottom(el);
  return true;
}

// Insert a mid-stream inject bubble directly before the live streaming
// assistant row — the DOM mirror of the splice-at-anchor sendMessage applied
// to activeChat.messages. Returns false (caller does a full render) when the
// live node can't be located.
function insertInjectBubbleInPlace(sessionId, injectMsg) {
  const el = document.getElementById('messages');
  if (!el || document.getElementById('empty')) return false;
  let liveNode = _liveMessageNodes.get(sessionId);
  if (!liveNode || !document.contains(liveNode)) {
    const all = el.querySelectorAll('.msg.assistant');
    liveNode = all[all.length - 1] || null;
  }
  if (!liveNode) return false;
  // renderMessage appends to #messages; relocate the bubble to the anchor slot.
  const userEl = renderMessage(injectMsg, {});
  if (!userEl) return false;
  el.insertBefore(userEl, liveNode);
  return true;
}
