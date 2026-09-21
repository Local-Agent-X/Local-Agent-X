// ── Chat: WebSocket connection + chatWs-dependent helpers ──
//
// Owns the chatWs lifecycle (connect / reconnect / drain / single dispatch),
// the heartbeat, the stuck-stream watchdog, and a small _findStreamingBodyEl
// helper that maps a sessionId to its live DOM bubble.
//
// Per-session stream state (content / toolEvents / opId / activity /
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
      retireChatWs('no pong since connection open — half-open from start');
      return;
    }
    if (Date.now() - window.chatWsLastPong > WS_PONG_TIMEOUT_MS) {
      retireChatWs('no pong within ' + WS_PONG_TIMEOUT_MS + 'ms — half-open');
      return;
    }
    try { chatWs.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {}
  }, WS_PING_INTERVAL_MS);
}
function stopChatWsHeartbeat() {
  if (chatWsPingTimer) { clearInterval(chatWsPingTimer); chatWsPingTimer = null; }
}


// Reconnect delay, and the single timer that enforces it — a retire and a
// natural onclose can both ask for a reconnect, and two timers means two
// sockets.
const WS_RECONNECT_DELAY_MS = 3000;
// A handshake that never completes (TCP black hole) fires no close event for
// as long as the OS keeps the connection attempt alive. Without a deadline the
// CONNECTING guard below would park the client on a socket that can never open.
const WS_CONNECT_TIMEOUT_MS = 10_000;
let chatWsReconnectTimer = null;
function scheduleChatWsReconnect() {
  if (chatWsReconnectTimer) return;
  chatWsReconnectTimer = setTimeout(() => {
    chatWsReconnectTimer = null;
    connectChatWs();
  }, WS_RECONNECT_DELAY_MS);
}

// Retire the current socket, then reconnect.
//
// close() on its own is not enough to stop a socket. It opens a handshake the
// PEER has to complete, and until it does the socket sits in CLOSING and keeps
// handing queued frames to onmessage. When the server's event loop is blocked
// for minutes — 218s and 252s in the 2026-09-21 incident — the socket we
// "closed" goes on feeding the same store its replacement is feeding, and
// every text delta is applied twice. Detaching the handlers is what actually
// retires it: from here the socket is dead to us whatever its readyState says,
// and the reconnect stops waiting on an onclose that may never arrive.
function retireChatWs(reason) {
  const ws = chatWs;
  if (!ws) return;
  console.warn('[ws] retiring chat socket — ' + reason);
  chatWs = null;
  stopChatWsHeartbeat();
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  try { ws.close(); } catch {}
  scheduleChatWsReconnect();
}

function connectChatWs() {
  // CONNECTING counts as live: replacing a socket mid-handshake orphans it.
  // It still opens, still subscribes, and from then on every frame the session
  // broadcasts is delivered to this page twice.
  if (chatWs && (chatWs.readyState === WebSocket.OPEN || chatWs.readyState === WebSocket.CONNECTING)) return;
  const wsUrl = `ws://${location.host}/ws/chat`;
  // Every handler below is bound to THIS socket and checks that it is still
  // the current one. A retired socket that keeps firing must change nothing.
  const ws = new WebSocket(wsUrl, ['lax-auth', AUTH_TOKEN]);
  chatWs = ws;

  const connectDeadline = setTimeout(() => {
    if (chatWs === ws && ws.readyState === WebSocket.CONNECTING) {
      retireChatWs('handshake did not complete within ' + WS_CONNECT_TIMEOUT_MS + 'ms');
    }
  }, WS_CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(connectDeadline);
    if (chatWs !== ws) return;
    console.log('[ws] Chat WebSocket connected');
    startChatWsHeartbeat();
    if (activeChat) ws.send(JSON.stringify({ type: 'subscribe', sessionId: activeChat.id }));
    // Reconnect-resume: for any chat ops in flight when the socket dropped,
    // ask the server to replay missed canonical events and re-attach to
    // the live tail.
    for (const info of ChatStreamStore.inflightOps()) {
      console.log(`[ws] reconnect_op opId=${info.opId}`);
      ws.send(JSON.stringify({
        type: 'reconnect_op',
        sessionId: info.sessionId,
        opId: info.opId,
        // Server treats <0 as replay-from-beginning; live envelopes never
        // carry _seq, so there is no client-side cursor (2026-07-13 audit).
        sinceSeq: -1,
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
        if (isTerminalStatus(w.status)) continue;
        try {
          ws.send(JSON.stringify({
            type: 'reconnect_op',
            sessionId: w.sessionId,
            opId: wIds[wi],
            sinceSeq: -1,
          }));
        } catch (e) { /* best-effort — watchdog will retry */ }
      }
    }
    // Rediscover pending approvals this client never saw the live
    // approval_requested for (page reload, server restart, second device) —
    // GET /api/approvals/pending is the durable source of truth.
    rediscoverPendingApprovals().catch(() => {});
  };

  // The durable-resolve reply (approval_resolved + delivery) is a bare
  // top-level frame — no {type:'event', sessionId} envelope, because the
  // op wasn't live in-process — so it never reaches the per-session event
  // dispatch in handleChatWsMessage. Intercept it here before delegating.
  ws.onmessage = (e) => {
    if (chatWs !== ws) return;
    if (handleDurableApprovalReply(e)) return;
    handleChatWsMessage(e);
  };

  ws.onclose = () => {
    clearTimeout(connectDeadline);
    if (chatWs !== ws) return;
    console.log('[ws] Chat WebSocket closed, reconnecting in 3s...');
    chatWs = null;
    stopChatWsHeartbeat();
    scheduleChatWsReconnect();
  };

  ws.onerror = () => {}; // onclose handles reconnect
}

// Connect on load
setTimeout(connectChatWs, 1000);

function stopChat() {
  if (!activeChat) return;
  // One stop authority. The WS `stop` aborts the turn's AbortController,
  // which the canonical runner has wired to opCancel — the running op
  // transitions cleanly to cancelling → cancelled server-side, killing any
  // warm-pool CLI process. When the socket is down, the HTTP endpoint hits
  // the same server path; no need to fire both.
  if (chatWs && chatWs.readyState === WebSocket.OPEN) {
    chatWs.send(JSON.stringify({ type: 'stop', sessionId: activeChat.id }));
  } else {
    fetch(`${API}/api/chats/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ sessionId: activeChat.id }),
    }).catch(() => {});
  }
  // Force-end the local stream entry immediately for instant UI feedback —
  // the STREAMING badge + inject-mode send button clear now rather than
  // waiting on the server's cancelled/`done` event to round-trip back over
  // the (still-open) socket.
  ChatStreamStore.endTurn(activeChat.id, 'Stopped by user');
  // Do NOT close chatWs here. The `stop` message above is already
  // per-session — the server cancels only this session's op. The socket is
  // shared across every open chat; tearing it down dropped every other
  // session's live events during the ~500ms reconnect window (healed only by
  // the 60s watchdog). Closing was an SSE-era leftover from before the
  // protocol went per-session.
  // The "stopped" indicator is NOT painted here — endTurn set a stopNote on
  // the entry, and the synchronous finalize it triggered (per-turn subscriber
  // → promoteLiveToMessages → finalizeLiveMessageInPlace) rendered it via the
  // stop-notice path. Hand-appending via innerHTML+= re-parsed the finalized
  // bubble and killed the tool cards' listeners.
  const stopBtn = document.getElementById('stop-btn');
  const sendBtn = document.getElementById('send-btn');
  if (stopBtn) stopBtn.style.display = 'none';
  if (sendBtn) sendBtn.disabled = false;
  stopSpeaking();
}

function isChatActive(sessionId) {
  return ChatStreamStore.isActive(sessionId);
}

// Single source of truth for "is the reader parked at the bottom?" Drives BOTH
// the sticky-follow pause (autoScroll respects userScrolledUp) AND the
// jump-to-bottom button's visibility. Runs on every scroll/resize AND is
// re-invoked by autoScroll after content changes (content growth alone doesn't
// fire a scroll event). Content-aware distance (chat-render.js) so the last
// assistant's reserved .pin-bottom room never reads as "scrolled up".
(function initScrollTracking() {
  const el = document.getElementById('messages');
  if (!el) { document.addEventListener('DOMContentLoaded', initScrollTracking); return; }
  const AWAY_THRESHOLD = 80; // px below the fold before the reader counts as scrolled up
  const btn = document.getElementById('scroll-bottom-btn');
  const sync = () => {
    const dist = (typeof _distFromContentBottom === 'function')
      ? _distFromContentBottom(el)
      : el.scrollHeight - el.scrollTop - el.clientHeight;
    const away = dist > AWAY_THRESHOLD;
    userScrolledUp = away;
    if (btn) btn.classList.toggle('show', away);
  };
  window._syncScrollBottomBtn = sync;
  el.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  // Click: re-engage follow and ride the content-aware scroll down to the tail.
  // The button only shows when there IS content below the fold, so autoScroll
  // always has somewhere to go here.
  if (btn) btn.addEventListener('click', () => {
    userScrolledUp = false;
    if (typeof autoScroll === 'function') autoScroll();
    else { el.scrollTop = el.scrollHeight; sync(); }
  });
})();

window.sendApprovalResponse = function(approvalId, approved, rememberForSession, opId) {
  try {
    if (chatWs && chatWs.readyState === 1) {
      const frame = { type: 'approval_response', approvalId, approved, rememberForSession: !!rememberForSession };
      // Durable-sourced cards (rediscovered via /api/approvals/pending)
      // carry the opId; the server needs it to resolve an approval that is
      // no longer live in-process. Live cards may not have one — omit then.
      if (typeof opId === 'string' && opId) frame.opId = opId;
      chatWs.send(JSON.stringify(frame));
    }
  } catch {}
  // Flip the store immediately so a re-render before the server's
  // approval_resolved echo can't resurrect the card as actionable.
  try { ChatStreamStore.resolveApprovalLocal(approvalId, approved); } catch {}
};

// Enforced plan mode toggle — session-scoped. Turning it OFF is the approval
// event that lets the agent make changes again. State lives server-side; the
// local mirror (window._laxPlanMode) is optimistic and reconciled by the
// server's plan_mode_changed echo + session_snapshot on (re)connect.
window.togglePlanMode = function() {
  if (!activeChat) return;
  const sid = activeChat.id;
  window._laxPlanMode = window._laxPlanMode || {};
  const enabled = !window._laxPlanMode[sid];
  try {
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'plan_mode', sessionId: sid, enabled }));
      window._laxPlanMode[sid] = enabled;
      if (typeof updateStatusBar === 'function') updateStatusBar(true);
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
