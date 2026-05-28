// ── ChatStreamStore — single source of truth for per-session stream state ──
//
// Replaces five overlapping maps (_liveStreams, streamingSessionId,
// inflightChatOps, activeChatsSet, plus the implicit "is X live" check spread
// across chat-ws.js + chat-send.js). The drift between these maps was the
// root cause of recurring stream/stop/badge bugs — fix it once at the source.
//
// Shape per entry (Map<sessionId, ChatStreamEntry>):
//   content         accumulated stream text
//   toolEvents      tool_start/tool_end records, in order
//   opId            canonical chat op (set on chat_op_started, cleared on done)
//   lastSeenSeq     for reconnect_op replay
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
      toolEvents: [],
      opId: null,
      lastSeenSeq: -1,
      lastActivityMs: 0,
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

  function ensure(sessionId) {
    let e = entries.get(sessionId);
    if (!e) { e = blank(sessionId); entries.set(sessionId, e); }
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
    e.toolEvents = [];
    e.opId = null;
    e.lastSeenSeq = -1;
    e.lastActivityMs = Date.now();
    e.status = 'streaming';
    e.abortReason = null;
    e.liveAnchorIndex = typeof anchorIdx === 'number' ? anchorIdx : -1;
    notify(sessionId, null);
    return e;
  }

  // Splice the finalized live row into chat.messages at the captured anchor
  // and clear the anchor. Single point of entry for "the live row enters
  // persisted history" — replaces the dual-write upsert path that mirrored
  // the row into messages[] mid-stream via the save-interval.
  // Returns the inserted msg, or null if nothing was streamed.
  function promoteLiveToMessages(sessionId, chat) {
    const e = entries.get(sessionId);
    if (!e || !chat || !Array.isArray(chat.messages)) return null;
    const content = e.content || '';
    const toolEvents = e.toolEvents || [];
    if (!content.trim() && toolEvents.length === 0) {
      e.liveAnchorIndex = -1;
      return null;
    }
    const msg = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
      _tools: toolEvents.length ? [...toolEvents] : undefined,
    };
    const raw = typeof e.liveAnchorIndex === 'number' ? e.liveAnchorIndex : chat.messages.length;
    const idx = Math.max(0, Math.min(raw, chat.messages.length));
    chat.messages.splice(idx, 0, msg);
    e.liveAnchorIndex = -1;
    return msg;
  }

  // Mutate entry from a raw WS event and notify subscribers. Events not in
  // the switch still fire notify so per-turn UI handlers see them (modals,
  // approval cards, voice visuals, etc.) without needing their own listener.
  function applyEvent(sessionId, event) {
    if (!sessionId || !event) return;
    const e = ensure(sessionId);
    const now = Date.now();
    switch (event.type) {
      case 'chat_op_started':
        if (event.opId) { e.opId = event.opId; e.lastSeenSeq = -1; }
        if (e.status === 'idle' || e.status === 'done') e.status = 'streaming';
        e.lastActivityMs = now;
        break;
      case 'stream':
        if (event.replace === true) e.content = event.text || '';
        else if (typeof event.delta === 'string') e.content += event.delta;
        e.lastActivityMs = now;
        break;
      case 'tool_start':
        e.toolEvents.push({ type: 'start', name: event.toolName, args: event.args, riskLevel: event.riskLevel });
        e.lastActivityMs = now;
        break;
      case 'tool_end':
        e.toolEvents.push({ type: 'end', name: event.toolName, allowed: event.allowed, result: (event.result || '').slice(0, 500) });
        e.lastActivityMs = now;
        break;
      case 'error':
        if (event.message) {
          e.abortReason = event.message;
          // Mirror the error into the visible bubble text. Dedup guards
          // against duplicate WS deliveries (server's emitErrorOnce dedups
          // per-op, but accumulated subscribers can still re-deliver — see
          // 2026-05-27 Nutrishop trace: 4 identical error bubbles from one
          // server event).
          const errText = '\n\nError: ' + event.message;
          if (!e.content.endsWith(errText)) e.content += errText;
        }
        e.lastActivityMs = now;
        break;
      case 'done':
        e.status = 'done';
        e.opId = null;
        e.lastActivityMs = now;
        break;
      default:
        e.lastActivityMs = now;
    }
    notify(sessionId, event);
  }

  // Per-op activity bump — used by the dispatcher when it sees an event
  // envelope carrying _opId/_seq so the watchdog stays honest even for
  // events that applyEvent doesn't otherwise touch.
  function bumpActivity(sessionId, seq) {
    if (!sessionId) return;
    const e = entries.get(sessionId);
    if (!e) return;
    if (typeof seq === 'number') e.lastSeenSeq = seq;
    e.lastActivityMs = Date.now();
  }

  // Force-terminate from a local action (stop button, transport error). The
  // dispatcher's `done` event normally clears state; this is for cases where
  // we can't wait for it (force-closing the WS, never-arrived done frame).
  function endTurn(sessionId, reason) {
    const e = entries.get(sessionId);
    if (!e) return false;
    if (e.status === 'done') return false;
    // Synthesize end events for orphan starts so a stopped/aborted turn
    // doesn't promote a tool card with a stuck indicator. Mirrors the
    // pre-refactor renderMessages cleanup that used to do this on the
    // fly when stripping stale _streaming flags.
    for (const te of e.toolEvents) {
      if (te.type === 'start' && !e.toolEvents.find(t => t.type === 'end' && t.name === te.name)) {
        e.toolEvents.push({ type: 'end', name: te.name, allowed: true, result: '(interrupted)' });
      }
    }
    e.status = 'done';
    e.opId = null;
    if (reason) e.abortReason = reason;
    e.lastActivityMs = Date.now();
    notify(sessionId, { type: 'done', _local: true, reason: reason || null });
    return true;
  }

  function setSidebarActive(sessionId, active) {
    if (!sessionId) return;
    const e = ensure(sessionId);
    if (e.sidebarActive === !!active) return;
    e.sidebarActive = !!active;
    notify(sessionId, null);
  }

  // Sync to the server's `active_chats` snapshot — sessions not in the list
  // lose their sidebar marker (but keep their streaming state if any).
  function setActiveSidebarSet(sessionIds) {
    const set = new Set(sessionIds || []);
    for (const [sid, e] of entries) {
      const next = set.has(sid);
      if (e.sidebarActive !== next) { e.sidebarActive = next; notify(sid, null); }
    }
    for (const sid of set) {
      const e = ensure(sid);
      if (!e.sidebarActive) { e.sidebarActive = true; notify(sid, null); }
    }
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
        out.push({ sessionId: e.sessionId, opId: e.opId, lastSeenSeq: e.lastSeenSeq, lastActivityMs: e.lastActivityMs });
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

  window.ChatStreamStore = {
    get, ensure,
    startTurn, applyEvent, bumpActivity, endTurn, promoteLiveToMessages,
    setSidebarActive, setActiveSidebarSet,
    isStreaming, isActive, inflightOps,
    subscribe, subscribeAll,
  };
})();
