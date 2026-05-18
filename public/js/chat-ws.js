// ── Chat: WebSocket connection + chatWs-dependent helpers ──
//
// Owns the chatWs lifecycle (connect / reconnect / drain / event dispatch),
// the in-flight chat-op tracker (inflightChatOps for canonical resume), the
// active-chat set used for sidebar attention markers, and a small
// _findStreamingBodyEl helper that maps a sessionId to its live DOM bubble.
//
// Also hosts the helpers other modules use to talk to chatWs without
// owning the reference:
//   window.chatWs                — read-only getter (Object.defineProperty)
//   window.sendChatWsControl(p)  — wraps chatWs.send for agent-feeds
//   window.sendApprovalResponse  — wraps chatWs.send for tool-cards
//
// Extracted from chat.js as part of the 400-LOC god-file split.
//
// External deps from chat.js / shared.js:
//   - apiFetch, esc, AUTH_TOKEN, API   (shared.js)
//   - activeChat                       (app.js — global)
//   - streamingSessionId, _liveStreams (chat.js — accessed via window.streamingSessionId / closure-bound at call time)
//   - addMessageEl, renderMessages, _upsertStreamingAssistant, savePartial
//                                      (chat.js — auto-window function decls; resolved at call time)

function _findStreamingBodyEl(sessionId) {
  if (!activeChat || activeChat.id !== sessionId) return null;
  const messages = document.getElementById('messages');
  if (!messages) return null;
  // DOM uses class 'msg assistant' (see addMessageEl). Older code here
  // looked for '.msg-row.assistant' which never matched after a UI
  // refactor — this helper silently returned null on every chat-switch
  // re-entry, leaving the streaming bubble frozen at the snapshot it
  // rendered on entry, with no incoming deltas able to update the DOM.
  const rows = messages.querySelectorAll('.msg.assistant');
  const last = rows[rows.length - 1];
  return last ? last.querySelector('.msg-body') : null;
}

// ──────────────────

// ── WebSocket Chat Connection ──
let chatWs = null;
let activeChatsSet = new Set();

// Heartbeat state. Browser WebSocket API doesn't expose protocol-level
// ping/pong, so we send {type:"ping"} every 25s and expect
// {type:"pong"} back. If no pong arrives within ~35s the connection is
// half-open (server-side dead, client's readyState lying as OPEN) — we
// force-close so onclose fires and the reconnect loop runs.
//
// Without this, fresh-install repro showed chat sends going into the WS
// buffer and never reaching the server. Restart-server "fixed it"
// because the server kicking all clients was the only signal that
// reached the half-open frontend. window.chatWsLastPong is read by
// chat-send.js to demote to HTTP fallback when WS health is stale.
let chatWsPingTimer = null;
// Sentinel = 0 ("no pong yet"). DO NOT initialize to Date.now() on load —
// that creates a 40s window where wsHealthy() returns true based on a
// pong that never arrived, and the first chat-send goes into a half-open
// WS buffer that the server never sees. The fresh-install
// chat-doesnt-work bug was exactly this: heartbeat correct, gate wrong.
// chat-send.js requires this to be a real timestamp (> 0) before trusting WS.
window.chatWsLastPong = 0;
const WS_PING_INTERVAL_MS = 25_000;
const WS_PONG_TIMEOUT_MS = 35_000;
function startChatWsHeartbeat() {
  stopChatWsHeartbeat();
  window.chatWsLastPong = 0;
  // Immediate ping on connection-up. Without this, the very first
  // send after page-load can race the 25s ping interval — chat-send.js
  // checks `chatWsLastPong > 0` and falls back to HTTP if no pong has
  // landed yet. The fire-and-validate-now approach lets a healthy WS
  // serve the first send instead of unnecessarily demoting to HTTP.
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

// Track in-flight canonical chat ops by opId. Populated when the server
// emits `chat_op_started` and cleared on terminal events (`done` / `error`).
// On WebSocket reconnect we replay missed canonical events for each one
// via `reconnect_op` so a connection drop becomes a brief visual pause
// rather than a lost response. Keyed by opId → sessionId so the replay
// reaches the right chat. lastActivityMs is bumped by handleChatWsMessage
// on every event for this op — the stuck-stream watchdog uses it to
// decide when to force a replay.
const inflightChatOps = new Map(); // opId → { sessionId, lastSeenSeq, lastActivityMs }

// Stuck-stream watchdog. The agent's response may be fully committed
// server-side but the client's `streamingSessionId` stays set because
// the `done` event was lost (one dropped frame mid-stream — not enough
// to trip the heartbeat, which checks pong roundtrip rather than
// per-message delivery). Symptom: bubble stays at "thinking…" forever
// even though the op is done. Manual workaround: navigate to another
// chat and back, which forces renderMessages() to pull saved text from
// activeChat.messages. This watchdog automates that recovery via the
// same `reconnect_op` server replay mechanism connectChatWs already uses
// on full WS reconnect.
//
// Cadence: check every 15s. Trigger threshold: 60s since the last
// event for an inflight op. The threshold is conservative — most
// real LLM stalls (slow provider, big context) clear well under 60s.
const STUCK_STREAM_CHECK_INTERVAL_MS = 15_000;
const STUCK_STREAM_REPLAY_THRESHOLD_MS = 60_000;
setInterval(function() {
  if (!chatWs || chatWs.readyState !== WebSocket.OPEN) return;
  var now = Date.now();
  for (var entry of inflightChatOps.entries()) {
    var opId = entry[0];
    var info = entry[1];
    var lastActivity = info.lastActivityMs || 0;
    if (lastActivity === 0 || now - lastActivity < STUCK_STREAM_REPLAY_THRESHOLD_MS) continue;
    console.warn('[ws] Stuck stream detected for opId=' + opId + ' (no events for ' + Math.round((now - lastActivity) / 1000) + 's) — replaying via reconnect_op');
    try {
      chatWs.send(JSON.stringify({
        type: 'reconnect_op',
        sessionId: info.sessionId,
        opId: opId,
        sinceSeq: info.lastSeenSeq,
      }));
      // Bump the timestamp so we don't spam reconnect_op every interval
      // while a slow replay is in flight. Real activity from the replay
      // will bump it again via handleChatWsMessage.
      info.lastActivityMs = now;
    } catch (e) {
      console.warn('[ws] reconnect_op send failed:', e && e.message);
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
    // Subscribe to active chat if we have one
    if (activeChat) chatWs.send(JSON.stringify({ type: 'subscribe', sessionId: activeChat.id }));
    // Reconnect-resume: for any chat ops that were in flight when the
    // socket dropped, ask the server to replay missed canonical events
    // and re-attach to the live tail. The server replays via
    // `reconnectOp(opId, sinceSeq)` and translates events back to chat
    // ServerEvents on this WS only (other connections are unaffected).
    for (const [opId, info] of inflightChatOps.entries()) {
      console.log(`[ws] reconnect_op opId=${opId} sinceSeq=${info.lastSeenSeq}`);
      chatWs.send(JSON.stringify({
        type: 'reconnect_op',
        sessionId: info.sessionId,
        opId,
        sinceSeq: info.lastSeenSeq,
      }));
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
  // Send stop via WS — preserves the legacy session-turn-lock abort path.
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: activeChat.id }));
    // Also cancel any canonical chat op still running for this session.
    // `cancel_op` routes through the canonical control API (`opCancel`)
    // which transitions the op cleanly to "cancelling" → "cancelled" and
    // signals the warm-pool to kill the CLI process. Without this, the
    // canonical op kept running server-side after a stop click and the
    // old `stop` only released the session lock.
    for (const [opId, info] of inflightChatOps.entries()) {
      if (info.sessionId === activeChat.id) {
        chatWs.send(JSON.stringify({ type: 'cancel_op', sessionId: activeChat.id, opId }));
      }
    }
  }
  // Also try HTTP fallback
  fetch(`${API}/api/chats/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ sessionId: activeChat.id }),
  }).catch(() => {});
  // Force stop local rendering immediately
  streamingSessionId = null;
  // Close and reconnect WS to kill any in-flight stream
  if (chatWs) {
    chatWs.close();
    setTimeout(connectChatWs, 500);
  }
  // Append "stopped" indicator to last message; drop the streaming pin so the
  // message bubble shrinks back to its natural height.
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
  // Stop TTS if speaking
  stopSpeaking();
}

function isChatActive(sessionId) {
  return activeChatsSet.has(sessionId);
}

// Detect when user scrolls away from bottom — pause auto-scroll
(function initScrollPause() {
  const el = document.getElementById('messages');
  if (!el) { document.addEventListener('DOMContentLoaded', initScrollPause); return; }
  el.addEventListener('wheel', () => {
    if (!streamingSessionId) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    userScrolledUp = !atBottom;
  });
  el.addEventListener('scroll', () => {
    if (!streamingSessionId) return;

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (atBottom) userScrolledUp = false;
  });
})();

// ──────────────────

window.sendApprovalResponse = function(approvalId, approved, rememberForSession) {
  try {
    if (chatWs && chatWs.readyState === 1) {
      chatWs.send(JSON.stringify({ type: 'approval_response', approvalId, approved, rememberForSession: !!rememberForSession }));
    }
  } catch {}
};

// ──────────────────

Object.defineProperty(window, 'chatWs', {
  get() { return chatWs; }
});

// ──────────────────

window.sendChatWsControl = function(payload) {
  try {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify(payload));
      return true;
    }
  } catch {}
  return false;
};

// ──────────────────

