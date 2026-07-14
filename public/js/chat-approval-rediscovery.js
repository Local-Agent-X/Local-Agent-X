// ── Chat: durable-approval rediscovery ──
//
// A pending approval is durable server-side (canonical pendingApproval
// column) — the live approval_requested WS event is not. Any client that
// wasn't connected when the ask went out (page reload, server restart,
// half-open reconnect) would otherwise never see the card and the op sits
// blocked until the ask times out.
//
// Split out of chat-ws.js for the 400-LOC gate; loads BEFORE chat-ws.js
// (same sibling pattern as the chat-ws-handler-* modules) so its connect
// hook + onmessage intercept can reference these at call time.
//
// External deps from siblings (resolved at call time):
//   - apiFetch                        (shared-api.js)
//   - activeChat                      (app.js — global)
//   - ChatStreamStore                 (chat-stream-store.js)
//   - applyApprovalRecordedState      (chat-tool-cards.js)
//   - renderMessages                  (chat-render.js)

// On every WS (re)connect (chat-ws.js onopen), pull the durable list and
// hydrate the current session's cards into the store through the same
// approval_requested reducer the live event uses — the reducer dedupes by
// approvalId, so a card the live path already delivered is a no-op.
async function rediscoverPendingApprovals() {
  if (typeof activeChat === 'undefined' || !activeChat) return;
  const sid = activeChat.id;
  let pending;
  try {
    const r = await apiFetch('/api/approvals/pending');
    if (!r || !r.ok) return;
    pending = await r.json();
  } catch { return; }
  if (!Array.isArray(pending)) return;
  const now = Date.now();
  let hydrated = false;
  for (const p of pending) {
    // Current session only — cards for other sessions hydrate when the user
    // switches there and the next (re)connect/subscribe runs this again.
    if (!p || !p.approvalId || p.sessionId !== sid) continue;
    // Server filters expired columns, but the fetch itself takes time and
    // clocks drift — never render a card whose ask window already closed.
    if (typeof p.expiresAt === 'number' && p.expiresAt <= now) continue;
    const entry = ChatStreamStore.get(sid);
    if (entry && entry.approvals.some(a => a.id === p.approvalId)) continue;
    // The op IS in flight server-side (blocked on this ask) — mark the turn
    // live first so renderMessages synthesizes the live row the card hangs
    // off. Order matters: chat_op_started on a 'done' entry wipes the
    // approval scratch, so it must precede the approval_requested.
    if (p.opId) ChatStreamStore.applyEvent(sid, { type: 'chat_op_started', opId: p.opId });
    ChatStreamStore.applyEvent(sid, {
      type: 'approval_requested',
      approvalId: p.approvalId,
      toolName: p.toolName,
      context: p.context,
      argsPreview: p.argsPreview,
      opId: p.opId,
      expiresAt: p.expiresAt,
    });
    ChatStreamStore.adoptTurn(sid, (activeChat.messages || []).length);
    scheduleApprovalExpiry(sid, p.approvalId, p.expiresAt);
    hydrated = true;
  }
  if (hydrated && typeof renderMessages === 'function') renderMessages();
}

// Flip a still-pending hydrated card to the timeout state when its ask
// window closes — the durable-resolve path would reject the answer anyway,
// so leaving the buttons actionable past expiresAt is a lie. Live cards
// don't need this: the server broadcasts approval_timeout for them.
function scheduleApprovalExpiry(sessionId, approvalId, expiresAt) {
  if (typeof expiresAt !== 'number') return;
  const delay = expiresAt - Date.now();
  if (delay <= 0) return;
  setTimeout(() => {
    const entry = ChatStreamStore.get(sessionId);
    const ap = entry && entry.approvals.find(a => a.id === approvalId);
    if (!ap || ap.status !== 'pending') return; // answered meanwhile
    ChatStreamStore.applyEvent(sessionId, { type: 'approval_timeout', approvalId });
    if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sessionId
        && typeof renderMessages === 'function') renderMessages();
  }, delay + 250); // small pad so the server-side expiry check agrees
}

// Bare {type:'approval_resolved', delivery:'recorded'} reply from the
// durable-resolve path (src/chat-ws/approval-durable-resolve.ts). Returns
// true when consumed. Live approval_resolved events arrive envelope-wrapped
// ({type:'event', sessionId, event}) and fall through to the dispatcher.
function handleDurableApprovalReply(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return false; }
  if (!msg || msg.type !== 'approval_resolved' || msg.delivery !== 'recorded' || !msg.approvalId) return false;
  try { ChatStreamStore.resolveApprovalRecorded(msg.approvalId, !!msg.approved); } catch {}
  // Patch the on-screen card in place — the store notify repaints on the
  // next full render, but the user is looking at THIS card right now.
  try {
    const safeId = (window.CSS && CSS.escape) ? CSS.escape(msg.approvalId) : msg.approvalId;
    const card = document.querySelector('.approval-card[data-id="' + safeId + '"]');
    if (card && typeof applyApprovalRecordedState === 'function') {
      applyApprovalRecordedState(card, !!msg.approved);
    }
  } catch {}
  return true;
}
