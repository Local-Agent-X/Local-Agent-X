// ── Chat: WebSocket connection + chatWs-dependent helpers ──
//
// Owns the chatWs lifecycle (connect / reconnect / drain / single dispatch),
// the heartbeat, the stuck-stream watchdog, and a small _findStreamingBodyEl
// helper that maps a sessionId to its live DOM bubble.
//
// Per-session stream state (content / toolEvents / opId / seq / activity /
// status) lives in ChatStreamStore — this module reads from the store for
// reconnect replay, watchdog scans, and stop-button cleanup. Worker-card
// state still lives in agentFeedsData (chat-agent-feeds.js) — it's
// opId-keyed worker data, not per-session chat state.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, AUTH_TOKEN, API   (shared.js)
//   - activeChat                       (app.js — global)

function _findStreamingBodyEl(sessionId) {
  if (!activeChat || activeChat.id !== sessionId) return null;
  const messages = document.getElementById('messages');
  if (!messages) return null;
  // DOM uses class 'msg assistant' (see addMessageEl). Older code looked
  // for '.msg-row.assistant' which never matched after a UI refactor —
  // the helper silently returned null on every chat-switch re-entry,
  // leaving the streaming bubble frozen at the snapshot it rendered on
  // entry.
  const rows = messages.querySelectorAll('.msg.assistant');
  const last = rows[rows.length - 1];
  return last ? last.querySelector('.msg-body') : null;
}

// ── WebSocket Chat Connection ──
let chatWs = null;

// Heartbeat state. Browser WebSocket API doesn't expose protocol-level
// ping/pong, so we send {type:"ping"} every 25s and expect {type:"pong"}
// back. If no pong arrives within ~35s the connection is half-open
// (server-side dead, client's readyState lying as OPEN) — we force-close
// so onclose fires and the reconnect loop runs.
//
// Without this, fresh-install repro showed chat sends going into the WS
// buffer and never reaching the server. Restart-server "fixed it"
// because the server kicking all clients was the only signal that
// reached the half-open frontend. window.chatWsLastPong is read by
// chat-send.js to demote to HTTP fallback when WS health is stale.
let chatWsPingTimer = null;
// Sentinel = 0 ("no pong yet"). DO NOT initialize to Date.now() on load —
// that creates a 40s window where wsHealthy() returns true based on a pong
// that never arrived, and the first chat-send goes into a half-open WS
// buffer the server never sees. chat-send.js requires this to be a real
// timestamp (> 0) before trusting WS.
window.chatWsLastPong = 0;
const WS_PING_INTERVAL_MS = 25_000;
const WS_PONG_TIMEOUT_MS = 35_000;
function startChatWsHeartbeat() {
  stopChatWsHeartbeat();
  window.chatWsLastPong = 0;
  // Immediate ping on connection-up — chat-send.js checks `chatWsLastPong > 0`
  // and falls back to HTTP if no pong has landed yet.
  try {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
  } catch {}
  chatWsPingTimer = setInterval(() => {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
    // First-tick check: if we've never received a pong since open, the
    // connection is half-open from the start — close + reconnect.
    if (window.chatWsLastPong === 0) {
      console.warn('[ws] No pong since connection open — half-open from start, forcing reconnect');
      try { chatWs.close(); } catch {}
      return;
    }
    if (Date.now() - window.chatWsLastPong > WS_PONG_TIMEOUT_MS) {
      console.warn('[ws] No pong within ' + WS_PONG_TIMEOUT_MS + 'ms — connection half-open, forcing reconnect');
      try { chatWs.close(); } catch {}
      return;
    }
    try { chatWs.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {}
  }, WS_PING_INTERVAL_MS);
}
function stopChatWsHeartbeat() {
  if (chatWsPingTimer) { clearInterval(chatWsPingTimer); chatWsPingTimer = null; }
}

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
setInterval(function() {
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
        sinceSeq: info.lastSeenSeq,
      }));
      // Bump activity so we don't spam reconnect_op every interval while a
      // slow replay is in flight. Real activity from the replay will bump
      // it again via the dispatcher.
      ChatStreamStore.bumpActivity(info.sessionId, info.lastSeenSeq);
    } catch (e) {
      console.warn('[ws] reconnect_op send failed:', e && e.message);
    }
  }
  // Worker ops live in agentFeedsData (chat-agent-feeds.js), not the chat
  // stream store — keep the worker-specific scan here. Symptom from the
  // field: "worker activity moved from 8 to 15 but i had to leave to
  // another page and come back" — bg_op_progress events landed server-side
  // but the bubble wasn't repainting until route re-entry. reconnect_op
  // replays the missed events on the same wire chat-turn replays use.
  // Skips terminal states (completed/failed/cancelled).
  if (typeof agentFeedsData === 'object' && agentFeedsData) {
    var workerIds = Object.keys(agentFeedsData);
    for (var i = 0; i < workerIds.length; i++) {
      var wid = workerIds[i];
      var w = agentFeedsData[wid];
      if (!w || !w.sessionId) continue;
      var ws = (w.status || '').toLowerCase();
      if (ws === 'completed' || ws === 'failed' || ws === 'cancelled') continue;
      var wLast = w.lastActivityMs || 0;
      if (wLast === 0 || now - wLast < STUCK_WORKER_REPLAY_THRESHOLD_MS) continue;
      console.warn('[ws] Stuck worker detected for opId=' + wid + ' (no events for ' + Math.round((now - wLast) / 1000) + 's) — replaying via reconnect_op');
      try {
        chatWs.send(JSON.stringify({
          type: 'reconnect_op',
          sessionId: w.sessionId,
          opId: wid,
          sinceSeq: -1,
        }));
        w.lastActivityMs = now;
      } catch (e) {
        console.warn('[ws] worker reconnect_op send failed:', e && e.message);
      }
    }
  }
}, STUCK_STREAM_CHECK_INTERVAL_MS);

function connectChatWs() {
  if (chatWs && chatWs.readyState === WebSocket.OPEN) return;
  const wsUrl = `ws://${location.host}/ws/chat`;
  chatWs = new WebSocket(wsUrl, ['lax-auth', AUTH_TOKEN]);

  chatWs.onopen = () => {
    console.log('[ws] Chat WebSocket connected');
    startChatWsHeartbeat();
    if (activeChat) chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: activeChat.id }));
    // Reconnect-resume: for any chat ops in flight when the socket dropped,
    // ask the server to replay missed canonical events and re-attach to
    // the live tail.
    for (const info of ChatStreamStore.inflightOps()) {
      console.log(`[ws] reconnect_op opId=${info.opId} sinceSeq=${info.lastSeenSeq}`);
      chatWs.send(JSON.stringify({
        type: 'reconnect_op',
        sessionId: info.sessionId,
        opId: info.opId,
        sinceSeq: info.lastSeenSeq,
      }));
    }
    // Also replay any non-terminal worker ops. The chat WS heartbeat
    // force-closes half-open connections — during the close → reconnect
    // window (~3s + handshake) bg_op_progress events are broadcast but not
    // delivered. Without this the sidebar card froze at whatever line was
    // last received and only caught up minutes later when the watchdog
    // tripped at 180s.
    if (typeof agentFeedsData === 'object' && agentFeedsData) {
      var wIds = Object.keys(agentFeedsData);
      for (var wi = 0; wi < wIds.length; wi++) {
        var w = agentFeedsData[wIds[wi]];
        if (!w || !w.sessionId) continue;
        var wStatus = (w.status || '').toLowerCase();
        if (wStatus === 'completed' || wStatus === 'failed' || wStatus === 'cancelled') continue;
        try {
          chatWs.send(JSON.stringify({
            type: 'reconnect_op',
            sessionId: w.sessionId,
            opId: wIds[wi],
            sinceSeq: -1,
          }));
        } catch (e) { /* best-effort — watchdog will retry */ }
      }
    }
  };

  chatWs.onmessage = handleChatWsMessage;

  chatWs.onclose = () => {
    console.log('[ws] Chat WebSocket closed, reconnecting in 3s...');
    stopChatWsHeartbeat();
    setTimeout(connectChatWs, 3000);
  };

  chatWs.onerror = () => {}; // onclose handles reconnect
}

// Connect on load
setTimeout(connectChatWs, 1000);

function stopChat() {
  if (!activeChat) return;
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: activeChat.id }));
    // Also cancel any canonical chat op still running for this session.
    // `cancel_op` routes through the canonical control API (`opCancel`)
    // which transitions the op cleanly to "cancelling" → "cancelled" and
    // signals the warm-pool to kill the CLI process. Without this, the
    // canonical op kept running server-side after a stop click and the
    // old `stop` only released the session lock.
    for (const info of ChatStreamStore.inflightOps()) {
      if (info.sessionId === activeChat.id) {
        chatWs.send(JSON.stringify({ type: 'cancel_op', sessionId: activeChat.id, opId: info.opId }));
      }
    }
  }
  // Also try HTTP fallback
  fetch(`${API}/api/chats/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ sessionId: activeChat.id }),
  }).catch(() => {});
  // Force-end the local stream entry immediately. Without this the
  // STREAMING badge + inject-mode send button stay lit because we
  // force-close the WS below and the server's `done` event (which normally
  // clears the stream) never arrives.
  ChatStreamStore.endTurn(activeChat.id, 'Stopped by user');
  // Close and reconnect WS to kill any in-flight stream
  if (chatWs) {
    chatWs.close();
    setTimeout(connectChatWs, 500);
  }
  // Append "stopped" indicator to last message; drop the streaming pin so
  // the message bubble shrinks back to its natural height.
  const msgs = document.querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last) {
    // Keep `pin-bottom` on the stopped turn — it's still the most recent
    // assistant reply, so it should keep the reserved viewport-height below.
    const body = last.querySelector('.msg-body');
    if (body && !body.textContent.includes('[stopped]')) {
      body.innerHTML += '<div style="color:var(--muted);font-size:.72rem;margin-top:8px;font-style:italic">[stopped by user]</div>';
    }
  }
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sendBtn) sendBtn.disabled = false;
  stopSpeaking();
}

function isChatActive(sessionId) {
  return ChatStreamStore.isActive(sessionId);
}

// Detect when user scrolls away from bottom — pause auto-scroll
(function initScrollPause() {
  const el = document.getElementById('messages');
  if (!el) { document.addEventListener('DOMContentLoaded', initScrollPause); return; }
  el.addEventListener('wheel', () => {
    if (!(activeChat && ChatStreamStore.isStreaming(activeChat.id))) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    userScrolledUp = !atBottom;
  });
  el.addEventListener('scroll', () => {
    if (!(activeChat && ChatStreamStore.isStreaming(activeChat.id))) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (atBottom) userScrolledUp = false;
  });
})();

window.sendApprovalResponse = function(approvalId, approved, rememberForSession) {
  try {
    if (chatWs && chatWs.readyState === 1) {
      chatWs.send(JSON.stringify({ type: 'approval_response', approvalId, approved, rememberForSession: !!rememberForSession }));
    }
  } catch {}
};

Object.defineProperty(window, 'chatWs', {
  get() { return chatWs; }
});

window.sendChatWsControl = function(payload) {
  try {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify(payload));
      return true;
    }
  } catch {}
  return false;
};
