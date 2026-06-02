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
//   chips           out-of-band tool chips (op-id, kill button, etc.)
//   progressByTool  toolName → { message } — latest tool_progress per tool
//   approvals       pending approval cards, status flips on approval_timeout
//   stopNote        single stop notice for this turn (last write wins)
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
      // Out-of-band tool chip data (opId+actions metadata) — last write
      // wins per tool card, append-only across the turn.
      chips: [],
      // toolName → { message } — latest progress event per tool name,
      // overwritten by each new tool_progress event. Matches the prior
      // surgical behavior (writes to the last card of that tool name).
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
    e.chips = [];
    e.progressByTool = {};
    e.approvals = [];
    e.stopNote = null;
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
    if (e.chips.length) msg._chips = [...e.chips];
    if (Object.keys(e.progressByTool).length) msg._progressByTool = { ...e.progressByTool };
    if (e.approvals.length) msg._approvals = e.approvals.map(a => ({ ...a }));
    if (e.stopNote) msg._stopNote = { ...e.stopNote };
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
        if (event.opId && e.doneOpIds.has(event.opId)) {
          // Stale start for an op we've already ended. Don't overwrite the
          // current opId with the dead one and don't re-light streaming.
          e.lastActivityMs = now;
          break;
        }
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
        e.toolEvents.push({ type: 'start', name: event.toolName, toolCallId: event.toolCallId, args: event.args, riskLevel: event.riskLevel });
        e.lastActivityMs = now;
        break;
      case 'tool_end': {
        // Preserve the media URL line through the 500-char cap so
        // chat-tool-cards.js attachMediaPreview can still render the
        // <img>/<video>. Long video prompts routinely push the trailing
        // `View: /videos/...` line past the cap, leaving the chat bubble
        // with the tool-detail text but no inline player or link.
        const raw = event.result || '';
        let result = raw.slice(0, 500);
        const mediaUrl = raw.match(/\/(?:images|videos)\/[A-Za-z0-9._-]+/);
        if (mediaUrl && !result.includes(mediaUrl[0])) {
          result = result.trimEnd() + '\nView: ' + mediaUrl[0];
        }
        e.toolEvents.push({ type: 'end', name: event.toolName, toolCallId: event.toolCallId, allowed: event.allowed, status: event.status, result });
        e.lastActivityMs = now;
        break;
      }
      case 'tool_chip':
        if (event.chip) e.chips.push(event.chip);
        e.lastActivityMs = now;
        break;
      case 'tool_progress':
        if (event.toolName) {
          e.progressByTool[event.toolName] = { message: event.message || '' };
        }
        e.lastActivityMs = now;
        break;
      case 'approval_requested':
        if (event.approvalId) {
          e.approvals.push({
            id: event.approvalId,
            toolName: event.toolName,
            context: event.context,
            argsPreview: event.argsPreview,
            status: 'pending',
            resolvedAt: null,
          });
        }
        e.lastActivityMs = now;
        break;
      case 'approval_timeout': {
        if (event.approvalId) {
          const ap = e.approvals.find(a => a.id === event.approvalId);
          if (ap) { ap.status = 'timeout'; ap.resolvedAt = now; }
        }
        e.lastActivityMs = now;
        break;
      }
      case 'stopped':
        e.stopNote = {
          reason: event.reason || 'Stopped.',
          debug: event.debug || null,
          firedBy: event.firedBy || null,
        };
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
        if (e.opId) e.doneOpIds.add(e.opId);
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

  // Shift the live anchor by `delta`. Used by the inject path so the
  // synthesized live assistant row (and the future finalized assistant from
  // promoteLiveToMessages) stays AFTER any mid-stream inject we just spliced
  // in before it. Caller passes 1 after splicing an inject at the current
  // anchor index.
  function bumpAnchor(sessionId, delta) {
    if (!sessionId || typeof delta !== 'number') return;
    const e = entries.get(sessionId);
    if (!e || e.liveAnchorIndex < 0) return;
    e.liveAnchorIndex += delta;
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
    if (e.opId) e.doneOpIds.add(e.opId);
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
    startTurn, applyEvent, bumpActivity, bumpAnchor, endTurn, promoteLiveToMessages,
    setSidebarActive, setActiveSidebarSet,
    isStreaming, isActive, inflightOps,
    subscribe, subscribeAll,
  };
})();
