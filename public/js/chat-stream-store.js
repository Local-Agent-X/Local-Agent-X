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
      // `reasoning` event lane. Kept separate from `content` so it renders in
      // a collapsible "Thinking" block and never pollutes the answer bubble or
      // persisted history. Cleared at turn start and on promote-to-message.
      reasoning: '',
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
    e.toolsSinceText = false;
    e.toolEvents = [];
    e.chips = [];
    e.progressByTool = {};
    e.approvals = [];
    e.stopNote = null;
    e.opId = null;
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
    // A stop before anything streamed must still promote a row — the
    // stopNote is the only record that the turn happened and was stopped;
    // without it the finalize early-returns, the placeholder keeps its
    // thinking dots, and the turn vanishes on reload. Idempotency holds:
    // the scratch-clear below nulls stopNote along with content/toolEvents,
    // so a redundant second `done` (watchdog replay) finds all three empty
    // and still returns null here.
    if (!content.trim() && toolEvents.length === 0 && !e.stopNote) {
      e.liveAnchorIndex = -1;
      return null;
    }
    const msg = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
      _tools: toolEvents.length ? [...toolEvents] : undefined,
    };
    // Carry the turn's reasoning onto the finalized row so the "Thinking" block
    // survives past the live stream — collapsed, available to expand later.
    if (e.reasoning) msg._reasoning = e.reasoning;
    if (e.chips.length) msg._chips = [...e.chips];
    if (Object.keys(e.progressByTool).length) msg._progressByTool = { ...e.progressByTool };
    if (e.approvals.length) msg._approvals = e.approvals.map(a => ({ ...a }));
    if (e.stopNote) msg._stopNote = { ...e.stopNote };
    const raw = typeof e.liveAnchorIndex === 'number' ? e.liveAnchorIndex : chat.messages.length;
    let idx = Math.max(0, Math.min(raw, chat.messages.length));
    // Self-correct a stale anchor: if the array was rebuilt under us (a racing
    // hydrate/sync) the captured index can land the reply before the user
    // prompt that triggered it. An assistant reply must follow its user turn —
    // if the clamped slot is at or before the trailing user message, drop the
    // reply to the end so it can't render above the question.
    let lastUserIdx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i] && chat.messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0 && idx <= lastUserIdx) idx = chat.messages.length;
    chat.messages.splice(idx, 0, msg);
    e.liveAnchorIndex = -1;
    // Clear the live scratch so a second promote (the stuck-stream watchdog's
    // reconnect_op replays a redundant `done`, which re-fires finalize → here)
    // has nothing to promote and the guard above returns null — otherwise the
    // still-populated content + liveAnchorIndex === -1 re-splices THIS row at
    // index 0, duplicating the assistant message at the top of the chat. Mirror
    // exactly what startTurn resets so a subsequent turn starts clean too.
    e.content = '';
    e.reasoning = '';
    e.toolEvents = [];
    e.chips = [];
    e.approvals = [];
    e.progressByTool = {};
    e.stopNote = null;
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
        if (event.opId) e.opId = event.opId;
        if (e.status === 'idle' || e.status === 'done') e.status = 'streaming';
        e.lastActivityMs = now;
        break;
      case 'stream':
        if (event.replace === true) { e.content = event.text || ''; e.toolsSinceText = false; }
        else if (typeof event.delta === 'string') {
          if (e.toolsSinceText && e.content && !e.content.endsWith('\n')) e.content += '\n\n';
          e.content += event.delta;
          e.toolsSinceText = false;
        }
        e.lastActivityMs = now;
        break;
      case 'reasoning':
        // Live chain-of-thought — accumulate on its own lane so the renderer
        // shows a collapsible "Thinking" block. Never touches `content`, so it
        // stays out of the answer bubble and the persisted message.
        if (typeof event.delta === 'string') e.reasoning += event.delta;
        e.lastActivityMs = now;
        break;
      case 'tool_start':
        // Idempotent by call id. The same tool_start can reach the store more
        // than once for a single dispatch (provider/transport replays, a
        // resubscribed WS listener). A duplicate start would render a second
        // tool card AND a second generate_image preview, so dedupe at the
        // source of truth rather than papering over it downstream.
        if (!event.toolCallId || !e.toolEvents.some(t => t.type === 'start' && t.toolCallId === event.toolCallId)) {
          e.toolEvents.push({ type: 'start', name: event.toolName, toolCallId: event.toolCallId, args: event.args, riskLevel: event.riskLevel });
        }
        e.toolsSinceText = true;
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
        // Idempotent by call id, same reasoning as tool_start above.
        if (!event.toolCallId || !e.toolEvents.some(t => t.type === 'end' && t.toolCallId === event.toolCallId)) {
          e.toolEvents.push({ type: 'end', name: event.toolName, toolCallId: event.toolCallId, allowed: event.allowed, status: event.status, result });
        }
        e.toolsSinceText = true;
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
      case 'approval_resolved': {
        // Without this the store only ever knew pending/timeout, so any
        // re-render during the turn resurrected a clicked card as a fresh
        // actionable prompt.
        if (event.approvalId) {
          const ap = e.approvals.find(a => a.id === event.approvalId);
          if (ap) { ap.status = event.approved ? 'approved' : 'denied'; ap.resolvedAt = now; }
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
          // 2026-05-27 live trace: 4 identical error bubbles from one
          // server event).
          const errText = '\n\nError: ' + event.message;
          if (!e.content.endsWith(errText)) e.content += errText;
        }
        e.lastActivityMs = now;
        break;
      case 'done':
        rememberDoneOp(e, e.opId);
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
  // envelope carrying _opId so the watchdog stays honest even for events
  // that applyEvent doesn't otherwise touch. (No seq tracking: the server
  // never stamps _seq on live broadcast envelopes — only the reconnect_op
  // replay path does — so client-side seq was dead weight. 2026-07-13 audit.)
  function bumpActivity(sessionId) {
    if (!sessionId) return;
    const e = entries.get(sessionId);
    if (!e) return;
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
    //
    // Match closure by toolCallId when the start carries one — a name-only
    // check considered a REPEATED tool's second start closed because the
    // first run's end matched by name, leaving the second card stuck. Name
    // matching remains only as the fallback for starts without an id
    // (providers whose ids don't line up start↔end). Pushing into the array
    // we iterate is safe: synthesized events are type 'end', so the
    // `type === 'start'` guard skips them.
    for (const te of e.toolEvents) {
      if (te.type !== 'start') continue;
      const closed = te.toolCallId
        ? e.toolEvents.some(t => t.type === 'end' && t.toolCallId === te.toolCallId)
        : e.toolEvents.some(t => t.type === 'end' && t.name === te.name);
      if (!closed) {
        e.toolEvents.push({ type: 'end', name: te.name, toolCallId: te.toolCallId, allowed: true, result: '(interrupted)' });
      }
    }
    // Surface the local stop through the same stopNote lane a server
    // `stopped` event uses, so promoteLiveToMessages carries it onto the
    // finalized row and the finalize paint renders the stop notice.
    // Previously stopChat hand-appended a '[stopped by user]' div via
    // innerHTML+= AFTER finalize — re-parsing the finalized bubble's DOM
    // (killing tool-card listeners) and duplicating what stopNote rendering
    // owns. Don't clobber a note the server already delivered.
    //
    // ONLY when reason is truthy: endTurn is NOT stop-only — it doubles as
    // the NORMAL completion finalizer for HTTP/SSE turns (chat-send-http.js
    // passes null; end-of-stream IS the done signal there). A null reason
    // means clean end, not a stop — stamping "Stopped." on it would persist
    // a bogus notice onto every HTTP-fallback turn.
    if (reason && !e.stopNote) {
      e.stopNote = { reason: reason, debug: null, firedBy: 'local-stop' };
    }
    rememberDoneOp(e, e.opId);
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

  // Optimistic local flip when the user clicks Approve/Deny — the server's
  // approval_resolved event confirms it, but a re-render in the gap between
  // click and server echo must not resurrect an actionable card. Scans all
  // entries because the card click only knows the approvalId.
  function resolveApprovalLocal(approvalId, approved) {
    for (const [sessionId, e] of entries) {
      const ap = e.approvals.find(a => a.id === approvalId);
      if (ap) {
        ap.status = approved ? 'approved' : 'denied';
        ap.resolvedAt = Date.now();
        notify(sessionId, null);
        return;
      }
    }
  }

  window.ChatStreamStore = {
    get, ensure,
    startTurn, applyEvent, bumpActivity, bumpAnchor, endTurn, promoteLiveToMessages,
    setSidebarActive, setActiveSidebarSet, resolveApprovalLocal,
    isStreaming, isActive, inflightOps,
    subscribe, subscribeAll,
  };
})();
