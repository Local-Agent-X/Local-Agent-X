// The `inject` frame: a user message typed while a turn is — or might still
// be — running. Split out of message-router.ts, whose header notes each
// handler is "small enough to keep inline". This one stopped being: routing
// reads three independent liveness signals, and it now has a DEFERRED half
// (promote-on-release) that outlives the frame that armed it. Inline, that
// second half would have sat 200 lines from the branch that arms it.
//
// Two outcomes, and the client must be told which:
//   - Something holds the session → queue it; the running turn drains it.
//   - Nothing holds it            → the message BECOMES a fresh turn.

import { createLogger } from "../logger.js";
import { getApprovalManager } from "../approval-manager.js";
import { broadcastToSession, getChatHandler } from "./state.js";
// Static imports for the inject hot path. Previously these were `await
// import(...)` inside the handler, but every `await` yields the event loop
// and the worker's continuation guard (worker.ts:178) could run in between —
// observing an empty queue, exiting op1, and then the resumed handler would
// route the inject through getChatHandler() as a fresh op2, racing op1's
// persistTurnState and writing the inject to session.messages BEFORE the
// original question. Keeping the inject path fully synchronous closes the
// race: enqueue happens in one event-loop turn, the guard sees it.
import { listOpsForSession, hasChatHandlerPending } from "../ops/session-bridge.js";
import { hasActiveTurn, onTurnRelease } from "../session/turn-lock.js";
import { pushInject, drainInjects, hasInjects } from "../agent-loop/inject-queue.js";

const logger = createLogger("chat-ws");

/** Handle one `inject` frame. Synchronous by contract — see the import note. */
export function handleInject(sessionId: string, text: string, clientInjectId?: string): void {
  try {
    // Route as fresh turn ONLY when nothing is live, no chat handler is
    // mid-prep for this session, and the turn lock is free. The pending
    // check closes a start-of-turn race: the user types fast and the inject
    // lands during runChatTurn's ~30-200ms prep — before the canonical op
    // exists, so listOpsForSession still returns [] — where a fresh-turn
    // route would spawn a parallel handler that races the original for the
    // session lock and lose the text. Queued, drainInjectsIntoTurn takes it.
    //
    // hasActiveTurn closes the MIRROR race at the turn's END, on every lane:
    // both ops signals read empty once the op hits terminal, but the lock is
    // held through the handler's salvage while the browser still streams. An
    // inject there took the fresh-turn branch, whose tryAcquireOrReplace
    // ABORTED the still-live turn — a takeover nobody asked for that left the
    // killed turn's partial answer on screen beside the new turn's re-answer
    // (one question rendered twice).
    //
    // What these three do NOT close: the PRE-acquire prep window on lanes
    // that never mark pending. markChatHandlerPending has exactly one
    // non-test caller (server/lifecycle.ts:105, the WS chat handler), and the
    // orchestrator acquires the lock only AFTER prep (run-chat-turn/
    // orchestrator.ts:194). So an inject during an HTTP/SSE, voice, telegram
    // or cron turn's prep still reads idle on all three and still opens a
    // parallel turn. Narrowed, not closed — closing it means moving the mark
    // (or the acquire) to runChatTurn's entry, which is the orchestrator's
    // call to make, not this router's.
    const liveOps = listOpsForSession(sessionId);
    const hasPending = hasChatHandlerPending(sessionId);
    const turnLocked = hasActiveTurn(sessionId);
    if (liveOps.length === 0 && !hasPending && !turnLocked) {
      const handler = getChatHandler();
      if (handler) {
        logger.info(`[ws-chat] inject routed to new turn sess=${sessionId} len=${text.length} (nothing live, lock free)`);
        // Ack it. Nothing DRAINED this message — it became the turn — but
        // `inject_consumed` is the only event the renderer acts on
        // (chat-ws-handler.js → handleInjectConsumed); `inject_queued` is
        // informational and clears nothing. Its client-side contract is "this
        // message is no longer pending, a turn has it", which is exactly true
        // here. Silence is not the honest option, it is the worse lie: the
        // local echo (chat-send.js tags it _queueState:'queued') keeps its
        // dimmed, pulsing "still waiting" hourglass, splitQueuedInjects
        // re-emits it BELOW the very answer it produced, and app-sync skips
        // hydrate for the active chat so a reload doesn't clear it either.
        if (clientInjectId) broadcastToSession(sessionId, { type: "inject_consumed", injectId: clientInjectId });
        handler(sessionId, text, []);
        return;
      }
      logger.warn(`[ws-chat] inject dropped sess=${sessionId} — no live ops and no chat handler`);
      return;
    }
    // A mid-turn user message while approval cards are pending = the user
    // answered in words, not clicks. Deny the cards FIRST (no suppression;
    // model may re-raise after reading) — this also unblocks a tool call
    // parked on the card, so the inject below actually gets drained
    // instead of sitting behind an indefinite approval wait.
    const denied = getApprovalManager().denyPendingForSession(sessionId);
    if (denied > 0) logger.info(`[ws-chat] user message denied ${denied} pending approval(s) sess=${sessionId}`);
    const injectId = pushInject(sessionId, text, clientInjectId);
    logger.info(`[ws-chat] inject queued sess=${sessionId} len=${text.length} id=${injectId.slice(0, 8)} liveOps=${liveOps.length} pending=${hasPending} locked=${turnLocked}`);
    broadcastToSession(sessionId, { type: "inject_queued", injectId });
    if (turnLocked) armPromoteOnRelease(sessionId);
  } catch (e) {
    logger.warn(`[ws-chat] inject failed: ${(e as Error).message}`);
  }
}

// A queued inject has exactly ONE drainer: drainInjectsIntoTurn, at the top of
// a turn iteration. An inject that lands after the running turn's last drain
// gate (decide-outcome-gates lateInjectGate) has nobody left to read it, so
// queuing alone left it in the map until the user sent ANOTHER message — from
// the user's side, a message typed and silently ignored. Queuing is the right
// call at the routing decision (a wait beats a takeover that kills a live
// turn), but the wait has to END. When the lock releases with the queue still
// full, whatever is left becomes its own turn.
//
// Only armed when the LOCK is what made us queue: with an op still live the
// turn's own iterations do the draining, and a session with no active turn has
// no release to hook.
function armPromoteOnRelease(sessionId: string): void {
  // One callback per queued inject; promotion drains the whole queue at once,
  // so the second and later callbacks find it empty and stand down. The list
  // dies with the turn, so nothing accumulates across turns.
  onTurnRelease(sessionId, () => {
    // Deferred one macrotask, because release is exactly when a REPLACEMENT
    // turn acquires: tryAcquireOrReplace awaits the released turn's completion
    // promise, and promise continuations are microtasks — they all run before
    // this setImmediate, so the re-check below sees the replacement and stands
    // down rather than starting a turn beside it.
    setImmediate(() => promoteOrphanedInjects(sessionId));
  });
}

function promoteOrphanedInjects(sessionId: string): void {
  // This runs from setImmediate, so it is its own error boundary — an escaping
  // throw here is an uncaught exception, not a failed frame. Same log lane as
  // handleInject's catch; nothing is swallowed silently.
  try {
    // Same three signals as the routing decision, for the same reason: anything
    // live will drain the queue itself on its next iteration, and starting a
    // turn beside it is the takeover this module exists to prevent.
    if (listOpsForSession(sessionId).length > 0) return;
    if (hasChatHandlerPending(sessionId)) return;
    if (hasActiveTurn(sessionId)) return;
    if (!hasInjects(sessionId)) return;
    // Check the handler BEFORE draining: with no way to start a turn, the queue
    // is the only place the text still exists — leave it there for the user's
    // next message rather than dropping it on the floor.
    const handler = getChatHandler();
    if (!handler) {
      logger.warn(`[ws-chat] inject(s) left queued sess=${sessionId} — lock released with no chat handler to promote them`);
      return;
    }
    const items = drainInjects(sessionId);
    if (items.length === 0) return;
    // Everything the user typed during the dead turn's tail, in order, as one
    // message — they were addressed to the same moment, and one turn answering
    // all of them is what a mid-turn drain would have produced.
    const text = items.map(i => i.text).join("\n\n");
    logger.info(`[ws-chat] promoting ${items.length} undrained inject(s) to a new turn sess=${sessionId} len=${text.length} (lock released, queue not empty)`);
    // Turn first, acks second — the reverse of the fresh-turn branch, because
    // here the text is already OUT of the queue: a throwing broadcast must not
    // be able to strand a message that no longer exists anywhere else. The
    // handler emits nothing before its first await, so the client still sees
    // the acks ahead of any turn output.
    handler(sessionId, text, []);
    // Same ack as the fresh-turn branch, and for the same reason: these echoes
    // are dimmed "queued" rows on the client and this is what un-dims them.
    for (const item of items) broadcastToSession(sessionId, { type: "inject_consumed", injectId: item.id });
  } catch (e) {
    logger.warn(`[ws-chat] inject promote-on-release failed sess=${sessionId}: ${(e as Error).message}`);
  }
}
