// ── Chat WS: stuck-stream watchdog ──
//
// Split from chat-ws.js (2026-09-21). chat-ws.js owns the
// socket's lifecycle; this file owns the periodic "is anything wedged" scan
// that rides on top of it. It reads the socket through `window.chatWs` — the
// accessor chat-ws.js publishes — rather than holding its own reference, so a
// retired socket can never be used here.
//
// Load order (app.html): after chat-ws.js, which defines window.chatWs.

(function() {

  // Stuck-stream watchdog. The agent's response may be fully committed
  // server-side but the client's stream entry stays in 'streaming' status
  // because the `done` event was lost (one dropped frame mid-stream — not
  // enough to trip the heartbeat, which checks pong roundtrip rather than
  // per-message delivery). Symptom: bubble stays at "thinking…" forever even
  // though the op is done. Manual workaround: navigate to another chat and
  // back, which forces renderMessages() to pull saved text. This watchdog
  // automates that recovery via the same `reconnect_op` server replay
  // mechanism connectChatWs already uses on full WS reconnect.
  //
  // Cadence: 15s. Threshold: 60s since last event for an inflight op. The
  // threshold is conservative — most real LLM stalls clear well under 60s.
  const STUCK_STREAM_CHECK_INTERVAL_MS = 15_000;
  const STUCK_STREAM_REPLAY_THRESHOLD_MS = 60_000;
  // Worker ops use a longer threshold than chat-turn ops. A chat turn that
  // goes silent for 60s is almost certainly stuck; a worker mid-build can
  // legitimately stall that long during `npm install` or a Codex CLI's
  // plan-then-write phase. 180s = 3min keeps the watchdog meaningful for
  // genuinely hung workers without spamming reconnect_op against healthy
  // long-running ops.
  var STUCK_WORKER_REPLAY_THRESHOLD_MS = 180_000;
  // One ask for the whole live set covers every quiet card, so at most one
  // per threshold, however many cards are quiet.
  var lastWorkersAskMs = 0;
  setInterval(function() {
    // Read the socket once per scan through the accessor chat-ws.js publishes:
    // a retired socket is no longer window.chatWs, so it can never be used here.
    var chatWs = window.chatWs;
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
    var now = Date.now();
    for (var info of ChatStreamStore.inflightOps()) {
      var lastActivity = info.lastActivityMs || 0;
      if (lastActivity === 0 || now - lastActivity < STUCK_STREAM_REPLAY_THRESHOLD_MS) continue;
      console.warn('[ws] Stuck stream detected for opId=' + info.opId + ' (no events for ' + Math.round((now - lastActivity) / 1000) + 's) — replaying via reconnect_op');
      try {
        chatWs.send(JSON.stringify({
          type: 'reconnect_op',
          sessionId: info.sessionId,
          opId: info.opId,
          // Server treats <0 as replay-from-beginning; live envelopes never
          // carry _seq, so there is no client-side cursor (2026-07-13 audit).
          sinceSeq: -1,
        }));
        // Bump activity so we don't spam reconnect_op every interval while a
        // slow replay is in flight. Real activity from the replay will bump
        // it again via the dispatcher.
        ChatStreamStore.bumpActivity(info.sessionId);
      } catch (e) {
        console.warn('[ws] reconnect_op send failed:', e && e.message);
      }
    }
    // Worker cards live in agentFeedsData (chat-agent-feeds.js), not the chat
    // stream store, and a quiet one is checked against the server's live
    // worker set (workers_list → reconcileAgentFeeds, the one judge): a card
    // whose end this page missed is cleared, a live one is left alone. It was
    // a reconnect_op replay, which cannot serve a card: the replay feeds the
    // chat stream of the card's session, never the card, and a build
    // orchestrator or a named agent has no op event log at all, so every quiet
    // spell drew "reconnect_op failed: unknown_op" over the chat (label-check,
    // 2026-11-23). A card's lastActivityMs is left alone too: it is what the
    // stall badge reads, and bumping it here made a quiet job look active.
    // Terminal cards are skipped: isTerminalStatus (chat-agent-feeds-render.js)
    // is the one status set.
    if (typeof agentFeedsData === 'object' && agentFeedsData && now - lastWorkersAskMs >= STUCK_WORKER_REPLAY_THRESHOLD_MS) {
      var workerIds = Object.keys(agentFeedsData);
      for (var i = 0; i < workerIds.length; i++) {
        var w = agentFeedsData[workerIds[i]];
        if (!w || isTerminalStatus(w.status)) continue;
        var wLast = w.lastActivityMs || 0;
        if (wLast === 0 || now - wLast < STUCK_WORKER_REPLAY_THRESHOLD_MS) continue;
        lastWorkersAskMs = now;
        try {
          if (typeof noteWorkersSnapshotAsked === 'function') noteWorkersSnapshotAsked();
          chatWs.send(JSON.stringify({ type: 'workers_list' }));
        } catch (e) {
          console.warn('[ws] workers_list send failed:', e && e.message);
        }
        break;
      }
    }
  }, STUCK_STREAM_CHECK_INTERVAL_MS);
})();
