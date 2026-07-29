// ── Chat: Rendering — approval cards ──
//
// The live-vs-settled shape decision for approval asks, split out of
// chat-render-artifacts.js for the 400-LOC budget. One entry point,
// renderApproval, returns one of two nodes:
//   - LIVE (still answerable) — the canonical actionable card from
//     makeApprovalCard, brought into view on arrival and, whenever the ask
//     carries the server's deadline, counting down to its auto-DENIAL.
//   - TERMINAL (settled, or riding on a finalized row) — a compact one-line
//     audit record with NO <button> in the DOM at all.
//
// Why the two shapes: a settled card used to keep its whole action box, both
// buttons merely `disabled` and dropped to opacity .5 by CSS — which still
// reads as clickable. An ask that expired unseen (auto-denied, so the command
// never ran) sat in the thread forever behind a green-looking Approve button,
// and chat-stream-finalize.js persists approvals onto the finalized row, so it
// came back on every reload.
//
// External deps (resolved at call time, runtime-only):
//   - makeApprovalCard   (chat-tool-cards.js) — canonical approval card DOM
//   - formatMsgTime      (chat-render.js)     — optional record timestamp

// Terminal wording. Every state except 'approved' means the tool did NOT run —
// say so, because a bare "Denied" / "Timed out" left users re-clicking a dead
// card waiting for something to happen.
function _approvalOutcome(ap) {
  const recorded = ap.delivery === 'recorded';
  switch (ap.status) {
    case 'approved':
      return { cls: 'approved', icon: '✓', text: recorded ? 'Approved — applies when the agent resumes' : 'Approved' };
    case 'denied':
      return { cls: 'denied', icon: '✗', text: recorded ? 'Denied — applies when the agent resumes' : 'Denied — nothing ran' };
    case 'timeout':
      return { cls: 'timeout', icon: '✗', text: 'Expired unanswered — auto-denied, nothing ran' };
    case 'superseded':
      // The user's chat reply dismissed the card (server-side
      // denyPendingForSession) — this is NOT a Deny and nothing ran. Rendering
      // it as "Denied" cost a live session ~10 minutes of "why won't the
      // secret modal open", so the guidance stays in the compact record too.
      return { cls: 'superseded', icon: '✗', text: 'Dismissed by your reply — nothing ran. Ask again (or re-send the request) to proceed.' };
    default:
      // Still 'pending' on a finalized row: the turn ended around an
      // unanswered ask, so it can never be answered from here.
      return { cls: 'timeout', icon: '✗', text: 'Never answered — the turn ended, nothing ran' };
  }
}

// Compact audit record for a settled ask: what was asked, what happened, when.
// The evidence must survive — stopping the card from LOOKING actionable is the
// fix, deleting the fact that an approval was asked and denied is not — so the
// full args preview stays reachable on hover.
function makeApprovalRecord(ap) {
  const outcome = _approvalOutcome(ap);
  const rec = document.createElement('div');
  rec.className = 'approval-record ' + outcome.cls;
  rec.setAttribute('data-id', ap.id || '');
  const detail = ap.argsPreview || ap.context || '';
  if (detail) rec.title = detail;
  const parts = [
    ['approval-record-icon', outcome.icon],
    ['approval-record-tool', ap.toolName || 'tool'],
    ['approval-record-outcome', outcome.text],
    ['approval-record-context', ap.context || ''],
    ['approval-record-time', (ap.resolvedAt && typeof formatMsgTime === 'function') ? formatMsgTime(ap.resolvedAt) : ''],
  ];
  for (const [cls, text] of parts) {
    if (!text) continue;
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    rec.appendChild(span);
  }
  return rec;
}

// Expiry auto-DENIES — the command silently never runs — so the line names the
// consequence, not just the clock. Returns false once the fuse has burned,
// which is how the shared ticker below knows it can stop.
function paintApprovalCountdown(el) {
  const left = Number(el.dataset.expiresAt) - Date.now();
  if (!(left > 0)) {
    el.textContent = 'Expired — auto-denied. Nothing ran.';
    el.classList.add('urgent');
    return false;
  }
  const secs = Math.ceil(left / 1000);
  el.textContent = 'Auto-denies in ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')
    + ' — if you do not answer, this does not run.';
  el.classList.toggle('urgent', left <= 60_000);
  return true;
}

// One shared ticker rewrites the text of every countdown in the document. It
// deliberately does NOT go through the store: a store notify rebuilds the whole
// live bubble (full markdown re-parse of the turn), and paying that once a
// second to move one digit would be far worse than the missing clock. Same
// shape as thinking-phrases.js's rotation timer — query the live document each
// tick rather than holding a node — which is also what makes it survive the
// per-frame bubble swap: the rebuilt card brings a fresh countdown node and the
// next tick simply finds that one. Stops itself once every fuse has burned or
// been answered, so an idle session isn't running a 1Hz timer.
let _countdownTicker = null;
function _startCountdownTicker() {
  if (_countdownTicker !== null) return;
  _countdownTicker = setInterval(function () {
    let anyLive = false;
    document.querySelectorAll('.approval-countdown[data-expires-at]').forEach(function (el) {
      // Already answered in the DOM: makeApprovalCard's click handler marks the
      // card the instant it is clicked, ahead of the store round-trip that
      // swaps it for a record. A fuse still threatening auto-denial under an
      // "Approved" status line is a lie, so it goes.
      const card = el.closest && el.closest('.approval-card');
      if (card && (card.classList.contains('approved') || card.classList.contains('denied'))) {
        el.remove();
        return;
      }
      if (paintApprovalCountdown(el)) anyLive = true;
    });
    if (!anyLive) { clearInterval(_countdownTicker); _countdownTicker = null; }
  }, 1000);
}

// The fuse under a live ask: the running clock plus what silence costs.
//
// `expiresAt` is the server's ABSOLUTE auto-deny instant, carried on the ask
// itself (approval_requested.expiresAt = requestedAt + APPROVAL_TIMEOUT_MS,
// src/approval-manager.ts) and stored by chat-stream-reducer.js. It is NEVER
// derived from when this client first painted the card, because first paint is
// not arrival: chat-ws-handler-chat-events.js only repaints the session being
// VIEWED, and rerenderLiveMessage paints inside requestAnimationFrame, which
// the browser pauses while the window is hidden, minimized or occluded
// (chat-render-live.js says so in its own comments). A paint-dated clock
// overstated the window by however long the frame was deferred — measured at
// four minutes of a five-minute budget, so the card read "4:00 left" at the
// instant the request was auto-denied. A clock that confident and that wrong on
// a security-approval surface is worse than no clock, which is exactly what an
// ask carrying no deadline gets (see renderApproval).
function makeApprovalFuse(expiresAt) {
  const el = document.createElement('div');
  el.className = 'approval-countdown';
  el.dataset.expiresAt = String(expiresAt);
  if (paintApprovalCountdown(el)) _startCountdownTicker();
  return el;
}

// Announce ledger: ids this client has already pulled the viewport to. The live
// bubble re-renders each ask many times a turn, and the turn is BLOCKED on the
// reader so the arrival scroll is correct — but doing it on every frame would
// be worse than the silence it replaces.
const _seenApprovals = new Set();

function _noteApproval(id) {
  if (!id || _seenApprovals.has(id)) return false;
  _seenApprovals.add(id);
  return true;
}

function announceApproval(id) {
  if (!id) return;
  // The card is usually built into a DETACHED node (chat-render-live.js builds
  // the fresh bubble into a temp div, then swaps it in), where scrolling does
  // nothing. Look it up in the live document a tick later instead.
  setTimeout(function () {
    let card = null;
    document.querySelectorAll('.approval-card.live').forEach(function (c) {
      if (!card && c.getAttribute('data-id') === id) card = c;
    });
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') {
      try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { card.scrollIntoView(); }
    }
    // Short attention flash on top of the standing .live treatment.
    card.classList.add('arriving');
    setTimeout(function () { card.classList.remove('arriving'); }, 2600);
  }, 50);
}

// The one entry point chat-render-artifacts.js calls per approval on a row.
// `historical` is stamped by chat-stream-finalize.js on promote: the turn is
// over, so nothing on a persisted row can still be answered no matter which
// status it carried when the stream ended.
function renderApproval(ap) {
  const live = (!ap.status || ap.status === 'pending') && !ap.historical;
  if (!live) return makeApprovalRecord(ap);
  const card = makeApprovalCard(ap.id, ap.toolName, ap.context, ap.argsPreview);
  card.classList.add('live');
  // Above the buttons — the consequence has to be read before the decision.
  // A null second argument appends, which is the right place anyway. The clock
  // is OPTIONAL: an ask that reaches us without the server's deadline (an
  // emitter that doesn't set one) gets the card with no fuse at all rather than
  // a locally invented one.
  if (typeof ap.expiresAt === 'number') {
    card.insertBefore(makeApprovalFuse(ap.expiresAt), card.querySelector('.approval-actions'));
  }
  if (_noteApproval(ap.id)) announceApproval(ap.id);
  return card;
}
