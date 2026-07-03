/**
 * In-process canonical-loop worker.
 *
 * One worker leases one op (via lease.ts), transitions it `queued` →
 * `running`, drives the turn_loop until terminal, and releases the lease.
 *
 * Lease lifecycle (Issue 08):
 *   - acquire on entry; abort if another worker holds a fresh lease.
 *   - heartbeat every `heartbeatIntervalMs` while driving turns.
 *   - release on exit IF we still own it (else recovery already emitted
 *     `lease_lost`; we don't double-emit).
 *
 * Resume protocol (PRD §11):
 *   - Starting `turnIdx` is derived from `readLatestOpTurn(opId).turnIdx + 1`,
 *     the source of truth — never from the denormalized
 *     `currentTurnIdx` cache (which can be stale after a crash before the
 *     post-commit op write landed).
 */
import { randomUUID } from "node:crypto";
import { readOp, writeOp } from "../ops/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp, isTerminalCanonicalState, IllegalTransitionError } from "./state-machine.js";
import { driveTurn } from "./turn-loop.js";
import { recordTerminalOutcome } from "./turn-loop/decide-outcome.js";
import { seedInitialUserMessage } from "./initial-prompt.js";
import {
  startCancelTracker,
  finalizeCancel,
  applyPreLeaseCancel,
  applyBoundaryCancel,
  type CancelTracker,
} from "./cancel-handler.js";
import {
  acquireLease,
  heartbeatLease,
  releaseLease,
  getLeaseConfig,
} from "./lease.js";
import { readLatestOpTurn } from "./store.js";
import { refreshAriKernelRunIfStuck } from "../ari-kernel/index.js";
import { getSessionForOp } from "../ops/session-bridge.js";
import { hasInjects, opConsumesInjects } from "../agent-loop/inject-queue.js";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";

// Fallback turn cap when the op carries no (or an invalid) iteration budget.
// The real cap is the op budget the entry runner stamped — see maxTurns below;
// this only guards a budget-less op against a runaway script.
const DEFAULT_MAX_TURNS = 64;

// Internal registry of live heartbeat timers keyed by workerId. Tests use
// `_pauseHeartbeat` to simulate a crashed worker (heartbeat stops, lease
// expires naturally).
const HEARTBEATS = new Map<string, NodeJS.Timeout>();

export interface WorkerHandle {
  workerId: string;
  done: Promise<void>;
}

export function runWorker(op: Op, adapter: Adapter): WorkerHandle {
  const workerId = `w-${randomUUID().slice(0, 8)}`;
  const done = drive(op, adapter, workerId);
  return { workerId, done };
}

/**
 * Test-only: stop the heartbeat for a worker without releasing its lease.
 * Simulates a process death — the lease will expire naturally and recovery
 * can pick up the op. NOT exported as part of the canonical-loop API; the
 * leading underscore signals "internal".
 */
export function _pauseHeartbeat(workerId: string): boolean {
  const t = HEARTBEATS.get(workerId);
  if (!t) return false;
  clearInterval(t);
  HEARTBEATS.delete(workerId);
  return true;
}

async function drive(op: Op, adapter: Adapter, workerId: string): Promise<void> {
  // Pre-lease cancel: an opCancel that landed before the scheduler pumped
  // routes the op directly queued → cancelled with no lease and no running.
  if (applyPreLeaseCancel(op)) return;

  if (!acquireLease(op.id, workerId)) {
    // Another worker holds a fresh lease. Recovery / scheduler logic
    // should have prevented this, but bail safely if not.
    return;
  }
  // Refresh local op with the post-acquire columns (lease + workerId).
  const fresh = readOp(op.id);
  if (fresh) Object.assign(op, fresh);

  emit(op.id, "lease_acquired", { workerId });

  // Subscribe BEFORE transitioning to running so any cancel mid-stream
  // during turn 0 is caught by the bus subscription.
  const tracker: CancelTracker = startCancelTracker(op, adapter);
  let leaseLost = false;
  let wallClockTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat interval: extend the lease periodically. If the lease was
  // stolen out from under us (recovery), abort the adapter and let the
  // turn-loop bail without committing the partial turn.
  const cfg = getLeaseConfig();
  const hb = setInterval(() => {
    if (!heartbeatLease(op.id, workerId)) {
      leaseLost = true;
      clearInterval(hb);
      HEARTBEATS.delete(workerId);
      void adapter.abort().catch(() => undefined);
    }
  }, cfg.heartbeatIntervalMs);
  HEARTBEATS.set(workerId, hb);

  // Op boundary: give ARI a fresh run if a PRIOR op left the singleton
  // firewall in restricted/quarantine mode. The runtime's run-state escalations
  // are per-run by design; LAX runs one firewall for the whole process, so
  // without this a single tripped guard bricks every later op into read-only
  // until restart. No-op when the kernel is healthy or inactive.
  try { refreshAriKernelRunIfStuck(); } catch { /* never let the ARI guard break op start */ }

  transitionOp(op, "running", "leased");

  // Wall-clock ceiling. Enforced HERE — the one place every entry path
  // (chat-runner, agent-runner, cron, sub-agents) converges — by reading the
  // budget the entry runner stamped onto the op. Firing opCancel routes the
  // stop through the same authority as a user Stop, so the running →
  // cancelling → cancelled transition and mid-stream adapter.abort() are
  // identical. Dynamic import avoids the worker → control-api → scheduler →
  // worker static cycle; the timer path is cold (only fires on overrun).
  const wallClockMs = op.contextPack?.budget?.maxWallTimeMs;
  if (typeof wallClockMs === "number" && Number.isFinite(wallClockMs) && wallClockMs > 0) {
    wallClockTimer = setTimeout(() => {
      void import("./control-api.js")
        .then(({ opCancel }) => opCancel(op.id, "wall-clock-ceiling"))
        .catch(() => undefined);
    }, wallClockMs);
  }

  // Seed the initial user op_message before the first driveTurn so the
  // adapter sees the task on turn 0 (PRD §11 parity with the legacy
  // worker's executeOp). Idempotent — recovery / re-entry sees existing
  // op_messages and skips.
  seedInitialUserMessage(op);

  let releaseReason = "released";
  try {
    // PRD §11 resume protocol: starting turn idx comes from disk, not
    // the in-memory cache. Survives a worker that committed a turn
    // but died before persisting the denormalized currentTurnIdx.
    const latest = readLatestOpTurn(op.id);
    let turnIdx = (latest?.turnIdx ?? -1) + 1;
    // Honor the iteration budget the entry runner stamped (chat-runner /
    // agent-runner both set contextPack.budget.maxIterations). A worker asked
    // to cap at N must stop at N — not silently run to the fixed floor. Fall
    // back to DEFAULT_MAX_TURNS only when the budget is missing or nonsensical.
    const budgetIterations = op.contextPack?.budget?.maxIterations;
    const maxTurns =
      typeof budgetIterations === "number" && Number.isFinite(budgetIterations) && budgetIterations > 0
        ? budgetIterations
        : DEFAULT_MAX_TURNS;
    let count = 0;
    for (;;) {
      if (count++ >= maxTurns) {
        releaseReason = "max_turns_exceeded";
        emit(op.id, "error", {
          code: "max_turns_exceeded",
          message: `worker exceeded maxTurns=${maxTurns}`,
          retryable: false,
        });
        // This break skips commitTurn — the normal running → terminal
        // transition — so the op would stay `running` and the chat UI would
        // hang on STREAMING with a live cursor forever (live failure
        // 2026-06-23). Fail the op explicitly, same as the adapter-error-
        // exhausted floor in turn-loop.ts, so it finalizes and the spinner
        // clears with a visible reason.
        //
        // Skipping commitTurn also skips decide-outcome, so a truncated op used
        // to escape the outcome ledger entirely — the completion metric went
        // blind to every run that hit the cap (and they're disproportionately
        // the bad ones: stalled, looping, or wrapping up over a broken build).
        // Record it as aborted before failing, so the metric stays honest.
        recordTerminalOutcome(op, "aborted");
        transitionOp(op, "failed", "max_turns_exceeded");
        break;
      }
      const r = await driveTurn(op, adapter, turnIdx, {
        isCancelled: () => tracker.cancelled || leaseLost,
      });

      if (leaseLost) {
        // Recovery has already emitted `lease_lost` and possibly
        // re-leased the op. Bail without writing anything more.
        releaseReason = "lease_lost";
        break;
      }

      // Mid-turn cancel: signal handler already transitioned running →
      // cancelling and started adapter.abort(). Finalize awaits abort and
      // closes out cancelling → cancelled. Partial turn is discarded.
      if (tracker.cancelled) {
        await finalizeCancel(op, tracker);
        releaseReason = "cancelled";
        break;
      }

      // JARVIS resume-gate: the inject queue is the source of truth for
      // "is the agent done?". The adapter signaled end_turn, but if the
      // user typed a follow-up while this turn was running and it's still
      // sitting in the queue, the agent ISN'T actually done — it just
      // didn't get to see the new input. Override terminalReason so the
      // worker loops one more turn; driveTurn will drainInjectsIntoTurn
      // at the top, append the user's text to op_messages, and the
      // adapter will see it as a fresh user message on the next call.
      //
      // Without this guard, mid-turn injects on long single-turn replies
      // (e.g. a 298-action tool loop that ends with end_turn) get
      // stranded forever — the agent finishes, the chat ends, the queue
      // sits populated until the user types again, and even then their
      // earlier inject mixes confusingly into a fresh request.
      //
      // Middleware resume-gate (P4.C2): a middleware that returned a
      // `nudge` from afterModelCall/afterToolExecution appended a
      // synthetic user message at turnIdx+1. Even when the adapter said
      // terminal=done, the agent isn't done — the nudge must be visible
      // on a next-turn model call. Override the break for any op type.
      //
      // Flush pending I/O before the check. A WS `inject` message that
      // arrived while driveTurn was returning is sitting in the poll
      // queue — without yielding here, the guard reads `hasInjects=false`,
      // the worker exits, and then the inject handler runs against a
      // terminal op, gets routed to getChatHandler() as a fresh op2, and
      // op2's persistTurnState races op1's — landing the inject in
      // session.messages BEFORE the original question on rehydrate.
      // setImmediate fires after the poll phase, so any queued WS message
      // (including the inject) has fully run and pushInject has landed
      // before we check.
      await new Promise<void>(resolve => setImmediate(resolve));
      const middlewareNudged = r.middlewareDirective?.kind === "nudge";
      if (r.terminalReason !== null && opConsumesInjects(op.type)) {
        const sessionId = getSessionForOp(op.id);
        if ((sessionId && hasInjects(sessionId)) || middlewareNudged) {
          // fall through to next iteration so drainInjectsIntoTurn at
          // the top of driveTurn pulls the user's queued message into
          // op_messages and the adapter sees it.
        } else {
          break;
        }
      } else if (r.terminalReason !== null) {
        if (middlewareNudged) {
          // Non-chat op with a middleware-injected nudge: keep looping
          // so the adapter sees the synthetic user message on the next
          // turn (mirrors legacy `continue` after pushing a nudge user
          // message in agent-loop/run.ts).
        } else {
          break;
        }
      }

      // Turn-boundary signal check (PRD §13 precedence: cancel > pause >
      // redirect). Re-read the op from disk to pick up any signal columns
      // the public control API may have written while this turn was
      // running.
      const reread = readOp(op.id);
      const cancelRequested = reread?.canonical?.cancelRequestedAt;
      const pauseRequested = reread?.canonical?.pauseRequestedAt;

      if (cancelRequested) {
        await applyBoundaryCancel(op, adapter);
        releaseReason = "cancelled";
        break;
      }

      if (pauseRequested) {
        if (reread?.canonical) op.canonical = reread.canonical;
        if (!op.canonical) op.canonical = {};
        op.canonical.pauseRequestedAt = null;
        // Direct write: explicitly clearing a signal column.
        writeOp(op);
        transitionOp(op, "paused", "pause_at_turn_boundary");
        releaseReason = "paused";
        break;
      }
      turnIdx++;
    }
  } catch (e) {
    releaseReason = `exception:${(e as Error).message}`;
    emit(op.id, "error", {
      code: "worker_exception",
      message: (e as Error).message,
      retryable: false,
    });
    // This catch used to emit the error and fall straight through to the
    // finally's lease release — leaving the op stuck non-terminal with the
    // lease nulled out. Finalize it here to a terminal state so recovery/UI
    // observe a real end instead of a permanent wedge (the chat event pump
    // waits for a terminal `state_changed` that never comes; the spinner never
    // clears). Triggers: disk-full during commitTurn, the fail-closed
    // unresolvable-model throw in middlewares/host.ts, a tool that throws
    // mid-dispatch, or a cancel that landed mid-turn just before a throw.
    //
    // Choose the terminal target by the state AT THE THROW:
    //   - `cancelling`: a cancel signal already moved running → cancelling
    //     (cancel-handler.ts), so running → failed is ILLEGAL — cancelling →
    //     cancelled is the only legal exit. Finalize the SAME way the
    //     non-throwing cancel branch above does (finalizeCancel: await abort,
    //     clear the signal, cancelling → cancelled). Without this the guarded
    //     running → failed below throws IllegalTransitionError, gets swallowed,
    //     and the op wedges `cancelling` + no-lease. finalizeCancel records no
    //     outcome — matching the normal cancel path, which never enters the
    //     completion ledger.
    //   - any other non-terminal state (`running`): record the forced outcome
    //     and transition → failed, mirroring the MAX_TURNS floor above.
    // recovery.ts still closes the class as a backstop (recoverStaleOp now
    // reclaims a non-terminal, no-lease orphan), but finalizing here means the
    // live chat path never has to wait for the boot sweep.
    //
    // Guard the transition and keep any failure from escaping this catch — an
    // escape would unwind past the finally's lease release and re-orphan the op.
    const stateAtThrow = op.canonical?.state;
    if (stateAtThrow && !isTerminalCanonicalState(stateAtThrow)) {
      try {
        if (stateAtThrow === "cancelling") {
          await finalizeCancel(op, tracker);
        } else {
          recordTerminalOutcome(op, "aborted");
          transitionOp(op, "failed", "worker_exception");
        }
      } catch (finalizeErr) {
        // IllegalTransitionError = the op raced to terminal between the guard
        // read and the write (the benign no-op cancel-handler / recovery
        // already rely on). Anything else (e.g. a disk write failure) is
        // surfaced rather than silently dropped — but never re-thrown.
        if (!(finalizeErr instanceof IllegalTransitionError)) {
          emit(op.id, "error", {
            code: "worker_finalize_failed",
            message: (finalizeErr as Error).message,
            retryable: false,
          });
        }
      }
    }
  } finally {
    clearInterval(hb);
    if (wallClockTimer) clearTimeout(wallClockTimer);
    HEARTBEATS.delete(workerId);
    tracker.off();
    const stillOwner = releaseLease(op.id, workerId);
    if (stillOwner) {
      emit(op.id, "lease_lost", { workerId, reason: releaseReason });
    }
    // !stillOwner means recovery has taken the lease and already emitted
    // `lease_lost { reason: "expired" }`. Don't double-emit.
  }
}
