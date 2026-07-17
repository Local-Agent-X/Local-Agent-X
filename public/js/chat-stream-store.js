// ── ChatStreamStore — single source of truth for per-session stream state ──
//
// Replaces five overlapping maps (_liveStreams, streamingSessionId,
// inflightChatOps, activeChatsSet, plus the implicit "is X live" check spread
// across chat-ws.js + chat-send.js). The drift between these maps was the
// root cause of recurring stream/stop/badge bugs — fix it once at the source.
//
// Split across five files to stay under the 400-LOC gate (load order in
// app.html): chat-stream-blocks.js (block-timeline helpers) →
// chat-stream-reducer.js (the applyEvent switch) → THIS file (state maps,
// turn start, subscriptions) → chat-stream-finalize.js (promote/endTurn) →
// chat-stream-store-approvals.js (approval + sidebar methods); the last two
// attach onto the exported object.
//
// Shape per entry (Map<sessionId, ChatStreamEntry>):
//   content         accumulated stream text (flat lane — persistence/TTS)
//   reasoning       accumulated chain-of-thought (flat lane)
//   blocks          ordered render timeline: text / reasoning / inject
//                   blocks in ARRIVAL order (see chat-stream-blocks.js)
//   toolEvents      tool_start/tool_end records, in order
//   chips           out-of-band tool chips (op-id, kill button, etc.)
//   progressByTool  toolName → { message } — latest tool_progress per tool
//   approvals       pending approval cards, status flips on approval_timeout
//   stopNote        single stop notice for this turn (last write wins)
//   opId            canonical chat op (set on chat_op_started, cleared on done)
//   lastActivityMs  for the stuck-stream watchdog
//   status          'idle' | 'streaming' | 'stopping' | 'done'
//   abortReason     string | null (e.g. "Stopped by user", error message)
//   sidebarActive   server-reported active marker OR local bg-op nudge —
//                   orthogonal from stream status, drives sidebar dot
//
// Subscription model:
//   subscribe(sessionId, cb)  cb(entry, event)        per-session
//   subscribeAll(cb)          cb(sessionId, entry, event)   any change
// `event` is the raw WS event that triggered the change (null when the
// store mutated without an event, e.g. setSidebarActive).

(function() {
  const entries = new Map();
  const subscribers = new Map();
  const globalSubs = new Set();

  function blank(sessionId) {
    return {
      sessionId,
      content: '',
      // Model chain-of-thought for the current turn, streamed on the
      // `reasoning` event lane. Kept separate from `content` so it never
      // pollutes the answer text or persisted history. Cleared at turn
      // start and on promote-to-message.
      reasoning: '',
      // Ordered render timeline (chat-stream-blocks.js). The renderer walks
      // this instead of the flat lanes so thinking, answer text, and
      // mid-turn injects appear where they actually happened in the turn.
      blocks: [],
      blockBoundary: false,
      blockSeq: 0,
      // Set when a tool event lands; the next stream delta is then the
      // first text of a NEW model turn, so we open a paragraph break before
      // it. Without this, turn N's trailing text and turn N+1's opening text
      // concatenate into one run-on line ("...2026 .Step 2 completed...")
      // because every turn's deltas append to the single `content` string.
      toolsSinceText: false,
      toolEvents: [],
      // Out-of-band tool chip data (opId+actions metadata) — last write
      // wins per tool card, append-only across the turn.
      chips: [],
      // toolName → { message } — latest progress event per tool name,
      // overwritten by each new tool_progress event.
      progressByTool: {},
      // Pending approval cards in arrival order. status flips to
      // 'timeout' when approval_timeout lands.
      approvals: [],
      // Single stop notice per turn — last write wins.
      stopNote: null,
      opId: null,
      // Ops we've already seen `done` for. A late chat_op_started carrying
      // one of these (server replay, dying subprocess, race after stop)
      // would otherwise re-light the streaming indicator on a finished
      // turn — see the self_edit stop-button regression where the chat
      // showed streaming for minutes after a successful stop.
      doneOpIds: new Set(),
      lastActivityMs: 0,
      // Timestamp of the last event that produced VISIBLE progress — stream
      // text, reasoning, tool cards/chips/progress. Deliberately NOT bumped
      // by the reducer's default case: op_heartbeat lands there, and a
      // heartbeat proves the op is alive, not that anything new is on
      // screen. The content-idle thinking indicator
      // (chat-render-artifacts.js) keys off this; lastActivityMs stays the
      // watchdog's lane.
      lastContentMs: 0,
      status: 'idle',
      abortReason: null,
      sidebarActive: false,
      // Index in chat.messages where the live assistant row should appear
      // during the current turn. Captured at startTurn (length of messages
      // at that moment). renderMessages uses it to synthesize the live row
      // at the right slot; promoteLiveToMessages splices the finalized row
      // in at the same index on `done`. -1 = no live row.
      liveAnchorIndex: -1,
    };
  }

  function get(sessionId) {
    if (!sessionId) return null;
    return entries.get(sessionId) || null;
  }

  // ── Growth bounds ──
  // A long-lived tab otherwise accumulates one entry per session ever
  // touched and one doneOpId per turn ever finished — both unbounded.
  //
  // Invariant: doneOpIds.size <= DONE_OP_CAP per entry. The set only exists
  // to reject STALE replays of recently-finished ops (see the doneOpIds
  // comment in blank()); a replay 200 ops later is not a plausible race, so
  // evicting the oldest is safe. Set iteration order is insertion order —
  // the first key is the oldest add.
  const DONE_OP_CAP = 200;
  function rememberDoneOp(e, opId) {
    if (!opId) return;
    e.doneOpIds.add(opId);
    while (e.doneOpIds.size > DONE_OP_CAP) {
      e.doneOpIds.delete(e.doneOpIds.keys().next().value);
    }
  }

  // Invariant: an entry is only pruned when NOTHING can still need it —
  // turn finished (status 'done'), no sidebar marker, no per-session
  // subscribers, and never the session the user is viewing. Runs on entry
  // creation only (see ensure), so a stable working set costs nothing and
  // no timer is needed. Deleting from a Map mid-iteration is spec-safe.
  const ENTRY_PRUNE_THRESHOLD = 60;
  function pruneEntries() {
    if (entries.size <= ENTRY_PRUNE_THRESHOLD) return;
    const viewingId = (typeof activeChat !== 'undefined' && activeChat) ? activeChat.id : null;
    for (const [sid, e] of entries) {
      if (sid === viewingId) continue;
      if (e.status !== 'done' || e.sidebarActive) continue;
      const subs = subscribers.get(sid);
      if (subs && subs.size > 0) continue;
      entries.delete(sid);
    }
  }

  function ensure(sessionId) {
    let e = entries.get(sessionId);
    if (!e) {
      // Opportunistic prune before growing the map — cheapest possible
      // trigger point that still bounds a long-lived tab.
      pruneEntries();
      e = blank(sessionId);
      entries.set(sessionId, e);
    }
    return e;
  }

  function notify(sessionId, event) {
    const e = entries.get(sessionId) || null;
    const subs = subscribers.get(sessionId);
    if (subs) for (const cb of subs) { try { cb(e, event || null); } catch {} }
    for (const cb of globalSubs) { try { cb(sessionId, e, event || null); } catch {} }
  }

  function startTurn(sessionId, anchorIdx) {
    const e = ensure(sessionId);
    e.content = '';
    e.reasoning = '';
    window._ChatBlocks.resetBlocks(e);
    e.toolsSinceText = false;
    e.toolEvents = [];
    e.chips = [];
    e.progressByTool = {};
    e.approvals = [];
    e.stopNote = null;
    e.opId = null;
    e.lastActivityMs = Date.now();
    e.lastContentMs = Date.now();
    e.status = 'streaming';
    e.abortReason = null;
    e.liveAnchorIndex = typeof anchorIdx === 'number' ? anchorIdx : -1;
    notify(sessionId, null);
    return e;
  }

  // Mutate entry from a raw WS event (the switch lives in
  // chat-stream-reducer.js) and notify subscribers. Events not in the
  // switch still fire notify so per-turn UI handlers see them (modals,
  // approval cards, voice visuals, etc.) without needing their own listener.
  function applyEvent(sessionId, event) {
    if (!sessionId || !event) return;
    const e = ensure(sessionId);
    window._chatStreamReduce(e, event, Date.now(), { rememberDoneOp });
    notify(sessionId, event);
  }

  // Per-op activity bump — used by the dispatcher when it sees an event
  // envelope carrying _opId so the watchdog stays honest even for events
  // that the reducer doesn't otherwise touch. (No seq tracking: the server
  // never stamps _seq on live broadcast envelopes — only the reconnect_op
  // replay path does — so client-side seq was dead weight. 2026-07-13 audit.)
  function bumpActivity(sessionId) {
    if (!sessionId) return;
    const e = entries.get(sessionId);
    if (!e) return;
    e.lastActivityMs = Date.now();
  }

  // Mid-turn user message → a block at the tail of the live timeline, so it
  // renders right under everything the agent has said so far and the
  // agent's next output continues beneath it. (It used to splice into
  // chat.messages ABOVE the whole live row, pinning the user's mid-turn
  // message above text written before it.) Only valid on a streaming entry.
  function addInject(sessionId, injectId, text) {
    const e = entries.get(sessionId);
    if (!e || e.status !== 'streaming' || !injectId) return false;
    window._ChatBlocks.addInjectBlock(e, injectId, text, 'queued');
    e.lastActivityMs = Date.now();
    e.lastContentMs = Date.now();
    notify(sessionId, null);
    return true;
  }

  // Server confirmed the inject was drained into the turn. Flips the block's
  // queued styling; when the block is missing but `text` is provided (replay
  // after a mid-turn reload killed the local echo), the block is
  // materialized at the tail — only while the turn is still streaming.
  function consumeInject(sessionId, injectId, text) {
    const e = entries.get(sessionId);
    if (!e || !injectId) return false;
    const changed = window._ChatBlocks.consumeInjectBlock(
      e, injectId, text, e.status === 'streaming');
    if (changed) notify(sessionId, null);
    return changed;
  }

  // Adopt an in-flight turn this client never started — page reload mid-turn,
  // or switching into a chat whose turn began while unwatched. The server's
  // subscribe replay has already refilled content/reasoning/blocks/toolEvents
  // via applyEvent, so startTurn (which wipes all of that) is the wrong tool:
  // adoption only needs an anchor so renderMessages can synthesize the live
  // row and promoteLiveToMessages knows where to splice on `done`. No-op
  // when a live anchor already exists (a locally-started turn).
  function adoptTurn(sessionId, anchorIdx) {
    if (!sessionId || typeof anchorIdx !== 'number') return false;
    const e = entries.get(sessionId);
    if (!e || e.liveAnchorIndex >= 0) return false;
    e.liveAnchorIndex = Math.max(0, anchorIdx);
    return true;
  }

  // Re-point an EXISTING live anchor after chat.messages was REPLACED under
  // it (hydrateChat swaps in the server's array — the user prompt is only
  // persisted server-side at send, never saved locally mid-turn, so the
  // server array is typically one longer). The anchor was sampled against
  // the pre-hydrate array; left alone it lands the live row ABOVE the user's
  // own prompt. Deliberately the inverse of adoptTurn's guard: adoption
  // refuses when an anchor exists, re-anchoring requires one.
  function reanchorTurn(sessionId, anchorIdx) {
    if (!sessionId || typeof anchorIdx !== 'number') return false;
    const e = entries.get(sessionId);
    if (!e || e.liveAnchorIndex < 0) return false;
    e.liveAnchorIndex = Math.max(0, anchorIdx);
    return true;
  }

  function isStreaming(sessionId) {
    const e = entries.get(sessionId);
    return !!e && e.status === 'streaming';
  }
  function isActive(sessionId) {
    const e = entries.get(sessionId);
    return !!e && (e.status === 'streaming' || e.sidebarActive);
  }

  // Snapshot of all in-flight chat ops — for reconnect_op replay on WS
  // reconnect and for the stuck-stream watchdog.
  function inflightOps() {
    const out = [];
    for (const e of entries.values()) {
      if (e.status === 'streaming' && e.opId) {
        out.push({ sessionId: e.sessionId, opId: e.opId, lastActivityMs: e.lastActivityMs });
      }
    }
    return out;
  }

  function subscribe(sessionId, cb) {
    let s = subscribers.get(sessionId);
    if (!s) { s = new Set(); subscribers.set(sessionId, s); }
    s.add(cb);
    return function unsubscribe() {
      const set = subscribers.get(sessionId);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) subscribers.delete(sessionId);
    };
  }
  function subscribeAll(cb) {
    globalSubs.add(cb);
    return function unsubscribe() { globalSubs.delete(cb); };
  }

  // Internal state handle for chat-stream-store-approvals.js (loads after
  // this file and attaches the approval + sidebar methods onto the export).
  window._ChatStreamState = { entries, ensure, notify, rememberDoneOp };

  window.ChatStreamStore = {
    get, ensure,
    startTurn, adoptTurn, reanchorTurn, applyEvent, bumpActivity,
    addInject, consumeInject,
    isStreaming, isActive, inflightOps,
    subscribe, subscribeAll,
  };
})();
