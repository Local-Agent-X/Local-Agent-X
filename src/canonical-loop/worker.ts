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
import { readOp, writeOp, withOpLock } from "../ops/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp, isTerminalCanonicalState, IllegalTransitionError } from "./state-machine.js";
import { driveTurn } from "./turn-loop.js";
import { recordTerminalOutcome } from "./turn-loop/record-outcome.js";
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
import { aggregateOpUsage } from "./op-usage.js";
import { ensureAriKernelScope, releaseAriKernelScope } from "../ari-kernel/index.js";
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

  // Operation boundary: each canonical op owns independent ARI run-state while
  // all scopes append to the same process-owned audit chain.
  try { ensureAriKernelScope(op.id); } catch { /* the evaluate path still fail-closes */ }

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
      if (count >= maxTurns) {
        const continuing = op.lane !== "interactive";
        emit(op.id, "iteration_checkpoint", {
          maxTurns,
          completedTurns: turnIdx,
          continuing,
        });
        if (!continuing) {
          releaseReason = "iteration_checkpoint";
          recordTerminalOutcome(op, "partial");
          transitionOp(op, "succeeded", "iteration_checkpoint");
          break;
        }
        // Autonomous lanes treat maxIterations as a checkpoint cadence. Keep
        // the same worker, lease, wall-clock timer, cancellation tracker, and
        // adapter registrations; only reset the cadence counter.
        count = 0;
      }
      count++;
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

      // Resume-gate lives upstream in decideTurnOutcome (turn-loop/decide-outcome.ts),
      // the ONLY place still `running` and session-bound: a mid-turn user inject or a
      // middleware nudge that must extend the conversation keeps terminalReason=null
      // there, so a non-null terminalReason here means the op is truly finished. A
      // worker-side re-check is provably dead — commitTurn already fired the
      // succeeded/failed transition, whose state_changed synchronously released the
      // op from its session, so getSessionForOp would return undefined (CL-5).
      if (r.terminalReason !== null) {
        break;
      }

      // Token-budget ceiling. Dormant unless a budget stamps a finite positive
      // maxTokens (nothing sets it today — the entry runners leave it 0). Mirrors
      // the max_turns floor above: read the op's cumulative tokens across every
      // persisted op_turn — driveTurn's commitTurn already inserted this turn's
      // row (synchronous writeFileSync) before returning, so the sum includes the
      // turn that just finished and the meter/enforcement never lags a turn — and
      // if the total meets/exceeds the cap, finalize the SAME way (error + aborted
      // outcome + running → failed + break).
      //
      // Placed AFTER the leaseLost / cancelled / natural-terminal checks, not
      // before them like the instruction's rough line, because at those earlier
      // points the op is NOT safely `running`: on leaseLost recovery owns the op
      // (writing failed here would clobber its re-lease), and on a natural-terminal
      // turn commitTurn already transitioned the op to succeeded/failed, so a
      // running → failed here would throw IllegalTransitionError. At this line the
      // op is provably still `running` and mid-loop, so the transition is legal.
      const maxTokens = op.contextPack?.budget?.maxTokens;
      if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
        const usage = aggregateOpUsage(op.id);
        const totalTokens = usage.usageInputTokens + usage.usageOutputTokens;
        if (totalTokens >= maxTokens) {
          releaseReason = "max_tokens_exceeded";
          emit(op.id, "error", {
            code: "max_tokens_exceeded",
            message: `worker exceeded maxTokens=${maxTokens} (used ${totalTokens})`,
            retryable: false,
          });
          recordTerminalOutcome(op, "aborted");
          transitionOp(op, "failed", "max_tokens_exceeded");
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
        // Clear the pause signal atomically (OP-9): another process's opCancel
        // can land between the reread above and this write. Re-read INSIDE the
        // per-op lock and keep every column from disk except the one we clear,
        // so a concurrent cancel/redirect written by another server is not
        // reverted by our stale in-memory op.
        withOpLock(op.id, () => {
          const fresh = readOp(op.id);
          if (fresh?.canonical) op.canonical = fresh.canonical;
          if (!op.canonical) op.canonical = {};
          op.canonical.pauseRequestedAt = null;
          writeOp(op);
        });
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
      releaseAriKernelScope(op.id);
    }
    // !stillOwner means recovery has taken the lease and already emitted
    // `lease_lost { reason: "expired" }`. Don't double-emit.
  }
}
