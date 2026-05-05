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
import { writeOp } from "../workers/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp } from "./state-machine.js";
import { driveTurn } from "./turn-loop.js";
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
  acquireLease(op, workerId);
  emit(op.id, "lease_acquired", { workerId });
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
      const r = await driveTurn(op, adapter, turnIdx);
      if (r.terminalReason !== null) break;
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
    releaseLease(op);
    emit(op.id, "lease_lost", { workerId, reason: releaseReason });
  }
}

function acquireLease(op: Op, workerId: string): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = workerId;
  op.canonical.leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  op.workerId = workerId;
  writeOp(op);
}

function releaseLease(op: Op): void {
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = null;
  op.canonical.leaseExpiresAt = null;
  writeOp(op);
}
