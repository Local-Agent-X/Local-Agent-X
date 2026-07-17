// ── ChatStreamStore: turn finalization ──
//
// promoteLiveToMessages + endTurn, attached onto window.ChatStreamStore
// after the core loads (app.html order); split out of chat-stream-store.js
// for the 400-LOC gate. Uses the _ChatStreamState handle the core exposes —
// no state of its own.

(function() {
  const S = window._ChatStreamState;
  const entries = S.entries;
  const notify = S.notify;
  const rememberDoneOp = S.rememberDoneOp;

  // Splice the finalized live row into chat.messages at the captured anchor
  // and clear the anchor. Single point of entry for "the live row enters
  // persisted history". Consumed mid-turn injects ride along inside the
  // row's _blocks (the agent answered around them); still-QUEUED injects
  // were never seen by this turn, so they're re-emitted as standalone user
  // rows right after the assistant row — pending input for the next turn.
  // Returns the inserted assistant msg, or null if nothing was streamed.
  function promoteLiveToMessages(sessionId, chat) {
    const e = entries.get(sessionId);
    if (!e || !chat || !Array.isArray(chat.messages)) return null;
    const content = e.content || '';
    const toolEvents = e.toolEvents || [];
    const split = window._ChatBlocks.splitQueuedInjects(e.blocks);
    // A stop before anything streamed must still promote a row — the
    // stopNote is the only record that the turn happened and was stopped;
    // without it the finalize early-returns, the placeholder keeps its
    // thinking dots, and the turn vanishes on reload. Idempotency holds:
    // the scratch-clear below nulls stopNote along with content/toolEvents/
    // blocks, so a redundant second `done` (watchdog replay) finds all of
    // them empty and still returns null here.
    if (!content.trim() && toolEvents.length === 0 && !e.stopNote
        && split.kept.length === 0 && split.queued.length === 0) {
      e.liveAnchorIndex = -1;
      return null;
    }
    const msg = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
      _tools: toolEvents.length ? [...toolEvents] : undefined,
    };
    // Carry the turn's timeline onto the finalized row so the interleaved
    // Thinking blocks / text / consumed injects survive past the live
    // stream. _reasoning stays as the legacy fallback shape (older rows in
    // localStorage render through it).
    if (split.kept.length) msg._blocks = window._ChatBlocks.snapshotBlocks(split.kept);
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
    // Still-queued injects become pending user rows AFTER the reply — the
    // server holds them for the next turn (or converts them to a fresh turn
    // itself); inject_consumed later finds these rows via _injectId.
    let after = idx + 1;
    for (const q of split.queued) {
      chat.messages.splice(after++, 0, {
        role: 'user', content: q.text, timestamp: q.ts || Date.now(),
        _injected: true, _injectId: q.injectId, _queueState: 'queued',
      });
    }
    e.liveAnchorIndex = -1;
    // Clear the live scratch so a second promote (the stuck-stream watchdog's
    // reconnect_op replays a redundant `done`, which re-fires finalize → here)
    // has nothing to promote and the guard above returns null — otherwise the
    // still-populated content + liveAnchorIndex === -1 re-splices THIS row at
    // index 0, duplicating the assistant message at the top of the chat. Mirror
    // exactly what startTurn resets so a subsequent turn starts clean too.
    e.content = '';
    e.reasoning = '';
    window._ChatBlocks.resetBlocks(e);
    e.toolEvents = [];
    e.chips = [];
    e.approvals = [];
    e.progressByTool = {};
    e.stopNote = null;
    return msg;
  }

  // Force-terminate from a local action (stop button, transport error). The
  // dispatcher's `done` event normally clears state; this is for cases where
  // we can't wait for it (force-closing the WS, never-arrived done frame).
  function endTurn(sessionId, reason) {
    const e = entries.get(sessionId);
    if (!e) return false;
    if (e.status === 'done') return false;
    // Synthesize end events for orphan starts so a stopped/aborted turn
    // doesn't promote a tool card with a stuck indicator.
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

  Object.assign(window.ChatStreamStore, { promoteLiveToMessages, endTurn });
})();
