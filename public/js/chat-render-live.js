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
//   - appendMessagesInPlace              — incremental row add
//
// preserveOpenState / captureActivityScroll / restoreActivityScroll live in
// chat-render-open-state.js (loads before this file).

// Per-session pointer to the live .msg.assistant DOM node — the bubble that
// rerenderLiveMessage swaps out on each WS event. Populated by the renderMessages
// loop (when it synthesizes the live row) and by rerenderLiveMessage (after swap).
// renderMessages wipes #messages then re-populates inside the loop, so we clear
// at the top.
const _liveMessageNodes = new Map();      // sessionId → .msg.assistant element
// Per-session rAF token so multiple rapid WS events coalesce into one swap
// per frame. The latest store state is read at flush time.
const _rerenderRafs = new Map();          // sessionId → rAF token

// Every swap rebuilds the whole live bubble, including a full markdown parse
// of ALL accumulated content — O(content length) per frame. Fine for short
// answers, but a tens-of-KB reply re-parsed up to 60×/second is the late-
// stream jank on big answers. Past this size, degrade from per-rAF to a time
// throttle. ~24k chars is a few screens of markdown — comfortably past where
// per-frame parse cost starts eating the frame budget, and short answers
// (the common case) never hit it.
const LIVE_THROTTLE_THRESHOLD_CHARS = 24_000;
// Minimum gap between swaps once throttled. 150ms is imperceptible during a
// long-answer tail — the reader is skimming a wall of text, not watching
// individual tokens land — and cuts the parse work ~10× vs 60fps.
const MIN_SWAP_INTERVAL_MS = 150;
const _rerenderTimers = new Map();        // sessionId → trailing setTimeout id
const _lastSwapAt = new Map();            // sessionId → ts of last completed swap

// ── Content-idle repaint ticker ──
// Swaps only fire when WS events arrive, so a turn that goes content-idle
// (long silent tool call) would get its next natural repaint at the 20s
// op_heartbeat — far too late for the 6s STREAM_IDLE_MS threshold in
// chat-render-artifacts.js. One lightweight interval watches the ACTIVE
// streaming session and repaints ONLY when the idle state differs from what
// the last swap painted, so a healthy fast stream never pays for it and the
// interval is a pure no-op when nothing is streaming. 3s ticks bound the
// indicator's appearance to at most STREAM_IDLE_MS + 3s.
const IDLE_TICK_MS = 3000;
const _lastIdlePainted = new Map();       // sessionId → idle state last painted
setInterval(() => {
  if (typeof activeChat === 'undefined' || !activeChat) return;
  const sid = activeChat.id;
  if (typeof ChatStreamStore === 'undefined' || !ChatStreamStore.isStreaming(sid)) return;
  const store = ChatStreamStore.get(sid);
  // Content-empty turns keep today's behavior — the turn-start thinking dots
  // are already showing, there's no idle/active flip to paint.
  if (!store || !(store.content || '')) return;
  const idle = isContentIdle(store);
  // rerenderLiveMessage is rAF/throttle-coalesced, safe to call here.
  if (idle !== !!_lastIdlePainted.get(sid)) rerenderLiveMessage(sid);
}, IDLE_TICK_MS);

// Paint + record the swap time so the throttle above measures from the last
// COMPLETED swap, not from when one was queued.
function _paintLiveSwap(sessionId) {
  if (_swapLiveMessage(sessionId)) _lastSwapAt.set(sessionId, Date.now());
}

// rAF-batched swap of the live assistant bubble from ChatStreamStore state.
// Called from dispatchChatStreamEvent after applyEvent so the bubble always
// reflects the latest store snapshot. Multiple events in one frame coalesce
// into a single swap.
//
// Off-screen sessions, post-done events, and missing live nodes are no-ops —
// renderMessages will catch up on next full render.
//
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
    // renderMessages run captured it into _liveMessageNodes). Only accept a
    // node explicitly stamped data-live="1" — the last .msg.assistant can be
    // a FINISHED message (reload mid-turn: subscribe replay re-lights
    // 'streaming' but startTurn never ran, so no live row was synthesized;
    // grabbing the last bubble here would OVERWRITE the previous finished
    // answer with live content) or a persisted worker bubble
    // (appendStaticWorkerBubble rows share .msg.assistant). Returning false
    // is safe: renderMessages catches up on the next full render.
    const messagesEl = document.getElementById('messages');
    if (messagesEl) {
      const all = messagesEl.querySelectorAll('.msg.assistant');
      const last = all[all.length - 1] || null;
      oldNode = (last && last.dataset.live === '1') ? last : null;
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
  // Record the idle state this paint actually rendered (same predicate the
  // build used) so the ticker above only fires on a genuine flip.
  _lastIdlePainted.set(sessionId, !!(store.content || '') && isContentIdle(store));
  autoScroll();
  return true;
}

function rerenderLiveMessage(sessionId) {
  if (!sessionId) return;
  if (!activeChat || activeChat.id !== sessionId) return;
  if (!ChatStreamStore.isStreaming(sessionId)) return;
  // A pending trailing timer already guarantees the latest store state paints;
  // stacking a rAF on top would defeat the throttle.
  if (_rerenderRafs.has(sessionId) || _rerenderTimers.has(sessionId)) return;
  const store = ChatStreamStore.get(sessionId);
  const size = store
    ? (store.content || '').length + (store.reasoning || '').length
    : 0;
  if (size > LIVE_THROTTLE_THRESHOLD_CHARS) {
    const elapsed = Date.now() - (_lastSwapAt.get(sessionId) || 0);
    if (elapsed < MIN_SWAP_INTERVAL_MS) {
      // Too soon after the last swap: arm a single trailing timer for the
      // remainder instead of dropping the delta — the LAST tokens of a turn
      // must always paint even if no further event arrives to trigger it.
      const timer = setTimeout(() => {
        _rerenderTimers.delete(sessionId);
        _paintLiveSwap(sessionId);
      }, MIN_SWAP_INTERVAL_MS - elapsed);
      _rerenderTimers.set(sessionId, timer);
      return;
    }
  }
  const token = requestAnimationFrame(() => {
    _rerenderRafs.delete(sessionId);
    _paintLiveSwap(sessionId);
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
  // Trailing throttle timers too — the catch-up paint below supersedes them,
  // and a survivor would double-paint (harmless but wasted parse work).
  for (const sessionId of Array.from(_rerenderTimers.keys())) {
    clearTimeout(_rerenderTimers.get(sessionId));
    _rerenderTimers.delete(sessionId);
  }
  if (activeChat && ChatStreamStore.isStreaming(activeChat.id)) {
    _paintLiveSwap(activeChat.id);
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
  // The turn is over: retire this session's throttle state. A trailing timer
  // left running would only no-op (_swapLiveMessage bails once isStreaming
  // flips false), but cancelling here keeps per-session state from outliving
  // the stream it belongs to.
  const timer = _rerenderTimers.get(sessionId);
  if (timer !== undefined) { clearTimeout(timer); _rerenderTimers.delete(sessionId); }
  _lastSwapAt.delete(sessionId);
  _lastIdlePainted.delete(sessionId);
  const el = document.getElementById('messages');
  if (!el || !finalizedMsg) return false;
  let oldNode = _liveMessageNodes.get(sessionId);
  if (!oldNode || !document.contains(oldNode)) {
    // Same data-live gate as _swapLiveMessage: an unmarked last bubble is a
    // finished answer or a worker bubble, and finalizing "in place" over it
    // would destroy it. Returning false hands the caller to renderMessages,
    // which paints the finalized turn correctly from activeChat.messages.
    const all = el.querySelectorAll('.msg.assistant');
    const last = all[all.length - 1] || null;
    oldNode = (last && last.dataset.live === '1') ? last : null;
  }
  if (!oldNode) return false;
  // Reshape the finalized message (promoteLiveToMessages output) back into the
  // store snapshot _buildLiveAssistantInto reads. Painting from the final
  // content here also covers the post-`done` frame the rAF rerender skips
  // (it bails once isStreaming flips false).
  const store = {
    content: finalizedMsg.content || '',
    reasoning: finalizedMsg._reasoning || '',
    blocks: finalizedMsg._blocks || [],
    toolEvents: finalizedMsg._tools || [],
    chips: finalizedMsg._chips || [],
    progressByTool: finalizedMsg._progressByTool || {},
    approvals: finalizedMsg._approvals || [],
    stopNote: finalizedMsg._stopNote || null,
  };
  const tmp = document.createElement('div');
  const fresh = _buildLiveAssistantInto(tmp, store);
  if (!fresh) return false;
  // Terminal paint: every Thinking block defaults to collapsed so the
  // finished answer leads. preserveOpenState below re-applies any explicit
  // user toggle (dataset.user) recorded on the old node.
  fresh.querySelectorAll('.reasoning-block').forEach(rb => { rb.open = false; });
  preserveOpenState(oldNode, fresh);
  const activityScroll = captureActivityScroll(oldNode);
  if (oldNode.classList.contains('pin-bottom')) fresh.classList.add('pin-bottom');
  // Drop the streaming affordance — this is the terminal paint. That includes
  // the data-live stamp _buildLiveAssistantInto applied: a finalized bubble
  // must never be adoptable by the last-assistant fallbacks above, or the
  // next turn's stream could clobber this finished answer.
  delete fresh.dataset.live;
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
// (bg-op nudge, sync hydrate) only ever add a row, so they go through this
// in-place path and fall back to a full render only when the DOM isn't in a
// known-good state. (Mid-stream injects no longer touch the thread: they are
// blocks INSIDE the live bubble — chat-stream-blocks.js — painted by the
// normal rerenderLiveMessage swap.)

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
