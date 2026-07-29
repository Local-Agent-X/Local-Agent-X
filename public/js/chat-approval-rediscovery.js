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
// hook + onmessage intercept can reference these at call time — and AFTER
// chat-stream-store.js, because the expiry watch at the bottom binds a
// store subscription at LOAD time (not at call time).
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
    // No scheduleApprovalExpiry call here: the applyEvent above already ran
    // it through the store's notify, which is the ONE arming site for both
    // the hydrated and the live ask (see watchApprovalExpiries below).
    hydrated = true;
  }
  if (hydrated && typeof renderMessages === 'function') renderMessages();
}

// ── Client-side ask expiry ──
//
// Armed timers by approvalId → { sessionId, timer }. Keyed by the ask so the
// live event and a rediscovery hydration of the SAME ask arm exactly one
// timer, and so the disarm sweep can cancel one by id.
const armedApprovalExpiries = new Map();

// Flip a card nothing has really settled to the timeout state when its ask
// window closes — the durable-resolve path would reject the answer anyway, so
// leaving the buttons actionable (or a click's guess standing) past expiresAt
// is a lie.
//
// Armed for LIVE asks too, not just hydrated ones. This used to assume the
// server always broadcasts approval_timeout for a card it delivered live; a
// starved event loop breaks that assumption (measured: 90-110s freezes, 182
// of them), and a broadcast that never fires leaves a dead card looking
// answerable forever. Cheap now that approval_requested carries expiresAt on
// the live event too (src/approval-manager.ts).
//
// Expiry stays the SERVER's decision — this only covers a MISSING broadcast,
// never a slow one, hence the pad below and no client-side arithmetic of its
// own. If the broadcast lands first the reducer settles the card and this
// timer finds it settled; if this fires first the reducer stamps settledBy
// 'timeout' and the late broadcast is a no-op. Either order, one settle.
//
// "Settled" here is _chatApprovalBeatsExpiry (chat-stream-reducer.js), NOT
// `status !== 'pending'`. The click flips the card optimistically before the
// server has confirmed the answer beat the deadline, so a card reading
// 'approved' may be one the server auto-denied with the tool never run — the
// exact card this fuse exists to correct. Disarming on that flip would hand
// the correction back to the broadcast this whole file assumes can vanish.
function scheduleApprovalExpiry(sessionId, approvalId, expiresAt) {
  if (!sessionId || !approvalId || typeof expiresAt !== 'number') return;
  if (armedApprovalExpiries.has(approvalId)) return; // already armed for this ask
  const delay = expiresAt - Date.now();
  if (delay <= 0) return;
  const timer = setTimeout(() => {
    armedApprovalExpiries.delete(approvalId);
    const entry = ChatStreamStore.get(sessionId);
    const ap = entry && entry.approvals.find(a => a.id === approvalId);
    if (!ap || window._chatApprovalBeatsExpiry(ap)) return; // really settled meanwhile
    ChatStreamStore.applyEvent(sessionId, { type: 'approval_timeout', approvalId });
    if (typeof activeChat !== 'undefined' && activeChat && activeChat.id === sessionId
        && typeof renderMessages === 'function') renderMessages();
  }, delay + 250); // small pad so the server-side expiry check agrees
  armedApprovalExpiries.set(approvalId, { sessionId, timer });
}

// One store subscription owns both ends of the timer's life. Every way an ask
// can APPEAR (live approval_requested, rediscovery hydration above) and every
// way one can be settled for real (server approval_resolved, the
// recorded-resolve reply, the server's own approval_timeout, a turn wipe that
// drops the card) ends in a store notify — so arming and disarming here needs
// no enumeration of those callers and can't miss one. A card no expiry could
// still correct never keeps a timer.
//
// The Approve/Deny click is deliberately NOT in that list. It flips the card
// optimistically and the server may reject the answer as too late, so the
// fuse stays lit until the server confirms — normally one round trip later,
// at which point the sweep below puts it out. The cost is the narrow race
// where a click DID beat the deadline but its approval_resolved is still in
// flight past expiresAt + the pad: the card shows the timeout for that gap and
// the arriving decision overwrites it. A card that self-corrects for one round
// trip beats one that lies for the rest of the session.
function watchApprovalExpiries(sessionId, entry, event) {
  if (event && event.type === 'approval_requested') {
    scheduleApprovalExpiry(sessionId, event.approvalId, event.expiresAt);
  }
  if (armedApprovalExpiries.size === 0) return; // the common case: no ask outstanding
  for (const [approvalId, armed] of armedApprovalExpiries) {
    const e = ChatStreamStore.get(armed.sessionId);
    const ap = e && e.approvals.find(a => a.id === approvalId);
    if (ap && !window._chatApprovalBeatsExpiry(ap)) continue; // still correctable — keep the fuse lit
    clearTimeout(armed.timer);
    armedApprovalExpiries.delete(approvalId); // deleting mid-iteration is spec-safe
  }
}

// Bound at load, like chat-uploads.js's updateStreamUI hook. Contained but
// LOUD: in production these files are concatenated into one script
// (src/server/static-bundle.ts) with no per-file wrapper, so a throw here
// would abort every top-level statement after it in the whole bundle —
// chat-ws.js's window.sendApprovalResponse and the chatWs accessor included,
// i.e. dead approval buttons, a far worse failure than the one it would
// announce. console.error keeps it out of the silent-disablement class this
// chunk exists to remove.
try {
  ChatStreamStore.subscribeAll(watchApprovalExpiries);
} catch (err) {
  console.error('[approvals] client-side ask expiry is DISABLED — could not subscribe to the stream store', err);
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
