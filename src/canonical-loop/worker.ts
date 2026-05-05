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
import { readOp, writeOp } from "../workers/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { driveTurn } from "./turn-loop.js";
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
import type { Op } from "../workers/types.js";
import type { Adapter } from "./adapter-contract.js";

const MAX_TURNS = 64; // Guard against runaway scripts. Real cap is op budget.

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

  transitionOp(op, "running", "leased");

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
    let count = 0;
    for (;;) {
      if (count++ >= MAX_TURNS) {
        releaseReason = "max_turns_exceeded";
        emit(op.id, "error", {
          code: "max_turns_exceeded",
          message: `worker exceeded MAX_TURNS=${MAX_TURNS}`,
          retryable: false,
        });
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

      if (r.terminalReason !== null) break;

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
  } finally {
    clearInterval(hb);
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
