// ── ChatStreamStore: frame admission ──
//
// Which frames are allowed to mutate an entry at all. Split from
// chat-stream-store.js (2026-09-21, 400-LOC gate) — the store core owns the
// maps and the turn lifecycle, this file owns the two "should this frame
// count" questions and nothing else. Both are pure over (entry, event).
//
// They exist for the same reason: delivery is not once-only, and the same
// frame can reach this page twice (a dead turn still flushing at the
// replacement's bubble; a socket the browser is still closing delivering
// alongside its replacement). One asks whose turn a frame belongs to, the
// other whether this page has already applied it.
//
// Must load before chat-stream-store.js (app.html order).

(function() {
// Content-bearing frame types the server stamps with their owning op
// (src/chat-ws/manager.ts stampOpId). Terminal/lifecycle frames are
// deliberately absent: a retired op's done/error/stopped must still land so
// the turn's bookkeeping closes out instead of hanging on 'streaming'.
const OP_SCOPED_TYPES = new Set([
  'stream', 'reasoning', 'tool_start', 'tool_end', 'tool_progress', 'tool_chip',
]);

// True when this frame belongs to a turn that was already taken over — a
// dead op still flushing buffered output at the replacement's bubble. A
// frame with NO opId is from an emitter that predates op attribution
// (manager.emit outside a live turn, replay's synthesized run deltas), so
// the un-stamped path keeps exactly its pre-attribution behavior.
// Reached through ChatStreamStore.isSupersededFrame, which resolves the
// sessionId to its entry — the WS dispatcher (chat-ws-handler.js) calls it that
// way so a dropped frame costs no bubble repaint and no TTS either.
function isSupersededFrame(e, event) {
  if (!event || !event.opId || !OP_SCOPED_TYPES.has(event.type)) return false;
  if (!e || !e.supersededOpIds.has(event.opId)) return false;
  // Pairing invariant: a tool_end whose tool_start is ALREADY on screen
  // still lands. Dropping one half of a pair is worse than rendering a dead
  // op's card — chat-render-artifacts.js pairs starts to ends, so an
  // unpaired start renders as a never-completing card, and the WS path
  // never runs endTurn's '(interrupted)' synthesis, so
  // promoteLiveToMessages persists it stuck forever. The takeover wipe
  // normally clears the start first (then the end closes nothing and is
  // correctly dropped); this covers the entries the wipe can't fire for,
  // e.g. one rendering a different op when the takeover was announced.
  if (event.type === 'tool_end' && event.toolCallId
      && e.toolEvents.some(t => t.type === 'start' && t.toolCallId === event.toolCallId)) {
    return false;
  }
  return true;
}

// True when this text frame has already been applied to the bubble.
//
// Text is the only lane where a duplicate delivery is destructive: every
// other frame type is idempotent by identity (tool_* by toolCallId,
// approval_* by approvalId, error by its own text, done is terminal), while
// a `stream` delta does a blind `content +=` and appends the same bytes
// twice. Delivery is NOT once-only — a socket the client is still closing
// keeps firing onmessage alongside its replacement, and during a long
// server-side event-loop stall that overlap lasts minutes (live failure
// 2026-09-21: the reply rendered twice, interleaved). So the server stamps
// each text frame with its position in the turn (chat-ws/manager.ts) and
// anything at or below the high-water mark is a copy.
//
// Frames with no `seq` are applied unchanged: replay synthesizes its run
// deltas without one (they follow a wipe that resets the mark, so they are
// authoritative by position), and an older server stamps nothing at all.
// Same convention as the un-stamped opId path above.
function isAppliedTextFrame(e, event) {
  if (event.type !== 'stream' && event.type !== 'reasoning') return false;
  // A replace is corrective, never additive — it cannot duplicate anything,
  // and dropping one would strand a stale partial on screen (the replay wipe
  // is a replace carrying the very mark the client may already hold). It
  // only moves the mark.
  if (event.replace === true) return false;
  if (typeof event.seq !== 'number') return false;
  return event.seq <= e.lastTextSeq;
}

/** Advance the high-water mark for a text frame that is about to be
 *  applied. Kept beside the guard so the two halves of the rule cannot
 *  drift apart. */
function markTextFrame(e, event) {
  if (event.type !== 'stream' && event.type !== 'reasoning') return;
  if (typeof event.seq === 'number') e.lastTextSeq = event.seq;
}

  window._ChatAdmit = { isSupersededFrame, isAppliedTextFrame, markTextFrame };
})();
