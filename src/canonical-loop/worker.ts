/**
 * In-process canonical-loop worker (Issue 03 scope).
 *
 * One worker leases one op, transitions it `queued` → `running`, drives
 * the turn_loop until terminal, and releases the lease. Issue 03 stops
 * here — pause/cancel/redirect signals + lease heartbeat / crash recovery
 * land in issues 05–08.
 *
 * Lease bookkeeping is filesystem-backed via writeOp on `ops`. Two-worker
 * contention is prevented at the scheduler layer (lane caps + active-op
 * map), not by atomic CAS — Issue 08 lifts the contention model when
 * heartbeat-driven re-leasing arrives.
 */
import { randomUUID } from "node:crypto";
import { readOp, writeOp } from "../workers/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { driveTurn } from "./turn-loop.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import {
  startCancelTracker,
  finalizeCancel,
  applyPreLeaseCancel,
  applyBoundaryCancel,
  type CancelTracker,
} from "./cancel-handler.js";
import type { Op } from "../workers/types.js";
import type { Adapter } from "./adapter-contract.js";

const LEASE_DURATION_MS = 30_000;
const MAX_TURNS = 64; // Guard against runaway scripts. Real cap is op budget.

export interface WorkerHandle {
  workerId: string;
  done: Promise<void>;
}

export function runWorker(op: Op, adapter: Adapter): WorkerHandle {
  const workerId = `w-${randomUUID().slice(0, 8)}`;
  const done = drive(op, adapter, workerId);
  return { workerId, done };
}

async function drive(op: Op, adapter: Adapter, workerId: string): Promise<void> {
  // Pre-lease cancel: an opCancel that landed before the scheduler pumped
  // routes the op directly queued → cancelled with no lease and no running.
  if (applyPreLeaseCancel(op)) return;

  acquireLease(op, workerId);
  emit(op.id, "lease_acquired", { workerId });
  // Subscribe BEFORE transitioning to running so any cancel that arrives
  // mid-stream during turn 0 is caught by the bus subscription.
  const tracker: CancelTracker = startCancelTracker(op, adapter);
  transitionOp(op, "running", "leased");

  let releaseReason = "released";
  try {
    let turnIdx = (op.canonical?.currentTurnIdx ?? -1) + 1;
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
      const r = await driveTurn(op, adapter, turnIdx, { isCancelled: () => tracker.cancelled });

      // Mid-turn cancel: signal handler already transitioned running →
      // cancelling and started adapter.abort(). Finalize awaits abort and
      // closes out cancelling → cancelled. The partial turn is discarded.
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
      const fresh = readOp(op.id);
      const cancelRequested = fresh?.canonical?.cancelRequestedAt;
      const pauseRequested = fresh?.canonical?.pauseRequestedAt;

      if (cancelRequested) {
        // Defensive: the bus signal subscription should have already fired
        // mid-turn. If we still see cancel_requested_at at the boundary,
        // the publish raced past the subscription — apply cancel inline.
        await applyBoundaryCancel(op, adapter);
        releaseReason = "cancelled";
        break;
      }

      if (pauseRequested) {
        // Clear the pause signal on disk FIRST so transitionOp's
        // persistOpKeepingSignals merge below doesn't resurrect it.
        if (fresh?.canonical) op.canonical = fresh.canonical;
        if (!op.canonical) op.canonical = {};
        op.canonical.pauseRequestedAt = null;
        writeOp(op); // direct write: we are explicitly clearing a signal column.
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
    tracker.off();
    releaseLease(op);
    emit(op.id, "lease_lost", { workerId, reason: releaseReason });
  }
}

function acquireLease(op: Op, workerId: string): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = workerId;
  op.canonical.leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  op.workerId = workerId;
  // Preserve any control-API signals that may already be queued up.
  persistOpKeepingSignals(op);
}

function releaseLease(op: Op): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = null;
  op.canonical.leaseExpiresAt = null;
  // Preserve any control-API signals that may have landed during the turn.
  persistOpKeepingSignals(op);
}
