/**
 * Crash recovery for canonical-loop ops (Issue 08).
 *
 * When a worker dies mid-turn its lease (`leaseOwner`, `leaseExpiresAt`)
 * stays on disk. After `leaseExpiresAt` passes any worker can take over.
 * `recoverStaleOp` is the canonical primitive that does the takeover
 * bookkeeping:
 *
 *   1. Re-read the op from disk.
 *   2. Verify `state ∈ {running, cancelling}` AND lease is expired. Stop
 *      otherwise — terminal ops, paused ops, queued-with-no-lease ops are
 *      not recoverable.
 *   3. Evict the dead worker from the scheduler's active map (frees a
 *      lane slot for the replacement).
 *   4. Clear the dead lease columns on disk.
 *   5. Emit `lease_lost { workerId, reason: "expired" }` so consumers
 *      observe the death before any state transition.
 *   6. Transition `running → queued` (or `cancelling → cancelled` if the
 *      op was already terminating; PRD §13 cancel always wins). The
 *      transition emits `state_changed` via state-machine.
 *   7. Re-enqueue + pump the scheduler (only when the recovery resumes
 *      work — cancelling ops jump straight to `cancelled`).
 *
 * Hard rule: lease.ts is the sole writer of lease columns and
 * state-machine.ts is the sole writer of canonical state. recovery.ts
 * orchestrates both — it never mutates either column directly outside
 * those primitives, except for the explicit lease-clear step that runs
 * just before emitting `lease_lost`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readOp } from "../ops/op-store.js";
import { emit } from "./event-emitter.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { isLeaseExpired } from "./lease.js";
import { evictWorker, enqueueOp, pumpScheduler } from "./scheduler.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import type { CanonicalLane } from "./types.js";

export type RecoveryOutcomeKind =
  | "recovered"     // running → queued, op re-enqueued.
  | "cancelled"     // cancelling → cancelled, no requeue.
  | "no_lease"      // op has no lease — nothing to recover.
  | "lease_fresh"   // lease still in date — leave it alone.
  | "not_running"   // op is not in a recoverable state.
  | "unknown_op";   // op id not on disk.

export interface RecoveryOutcome {
  ok: boolean;
  kind: RecoveryOutcomeKind;
  /** Worker id that lost the lease (when applicable). */
  expiredWorkerId?: string;
}

export function recoverStaleOp(opId: string): RecoveryOutcome {
  const op = readOp(opId);
  if (!op) return { ok: false, kind: "unknown_op" };
  const state = op.canonical?.state;
  if (state !== "running" && state !== "cancelling") {
    return { ok: false, kind: "not_running" };
  }
  if (!op.canonical?.leaseOwner) {
    return { ok: false, kind: "no_lease" };
  }
  if (!isLeaseExpired(op)) {
    return { ok: false, kind: "lease_fresh" };
  }

  const expiredWorkerId = op.canonical.leaseOwner;
  // Drop the scheduler's claim on the dead worker so the replacement
  // launch is not blocked by the lane cap. Idempotent.
  evictWorker(opId);

  // Clear the expired lease columns on disk via persistOpKeepingSignals
  // so we don't clobber control-API signals. This must precede the
  // `lease_lost` emit so any consumer reading the op upon receiving
  // the event observes the cleared lease.
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = null;
  op.canonical.leaseExpiresAt = null;
  op.workerId = undefined;
  // Recovery is one of the two legitimate writers of lease columns
  // (alongside lease.ts). Opt out of disk-preservation so this clear
  // actually lands.
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });

  emit(opId, "lease_lost", { workerId: expiredWorkerId, reason: "expired" });

  if (state === "cancelling") {
    // Worker died mid-cancel. PRD §13 cancel always wins — finalize the
    // cancellation here instead of resuming. Adapter is gone with the
    // worker, so no further `abort()` is possible; just close the state.
    safeRecoveryTransition(opId, "cancelled", "lease_expired_during_cancel");
    return { ok: true, kind: "cancelled", expiredWorkerId };
  }

  // running → queued: the loop is generic over what comes next. The
  // replacement worker reads `op_turns` for the resume turnIdx and
  // hands prior `provider_state` to the adapter (PRD §11).
  safeRecoveryTransition(opId, "queued", "lease_expired");
  enqueueOp(opId, op.lane as CanonicalLane);
  pumpScheduler();
  return { ok: true, kind: "recovered", expiredWorkerId };
}

/**
 * Bulk recovery — scans a list of op ids and recovers any that are
 * currently running with an expired lease. Use cases:
 *   - Janitor sweep on a timer.
 *   - Test setup that wants to clean up after simulating a crash.
 *
 * Returns one outcome per op id, in input order.
 */
export function recoverStaleOps(opIds: string[]): RecoveryOutcome[] {
  return opIds.map(recoverStaleOp);
}

/**
 * Boot-time sweep of stale canonical-loop ops on disk.
 *
 * When the server gets SIGTERM mid-op, the worker dies but the lease
 * row on disk still says `running` with a now-expired `leaseExpiresAt`.
 * Without this sweep, that op stays "running" forever — no janitor, no
 * re-acquire, just an orphan polluting the AGENTS sidebar and the
 * `op_status` listing until something explicitly drives recovery.
 *
 * The sweep walks `~/.lax/operations/`, finds canonical ops where:
 *   - `op.canonical.flagValue === true`
 *   - `op.canonical.state ∈ {running, cancelling}` (queued / paused
 *     don't have leases to expire; terminal states are absorbing)
 *   - `op.canonical.leaseOwner` is set
 *   - `isLeaseExpired(op)` is true
 * and routes each through `recoverStaleOp`.
 *
 * Safe to call exactly once at server boot. No-op if the operations
 * dir is missing. Resilient to per-op read errors (logs and skips).
 *
 * Returns the list of outcomes for logging by the caller.
 */
export function sweepStaleCanonicalOps(): { opId: string; outcome: RecoveryOutcome }[] {
  const opsBase = join(homedir(), ".lax", "operations");
  if (!existsSync(opsBase)) return [];

  let opIds: string[];
  try { opIds = readdirSync(opsBase); } catch { return []; }

  const out: { opId: string; outcome: RecoveryOutcome }[] = [];
  for (const opId of opIds) {
    let op;
    try { op = readOp(opId); } catch { continue; }
    if (!op) continue;

    const c = op.canonical;
    if (!c || c.flagValue !== true) continue;
    if (c.state !== "running" && c.state !== "cancelling") continue;
    if (!c.leaseOwner) continue;
    if (!isLeaseExpired(op)) continue;

    const outcome = recoverStaleOp(opId);
    out.push({ opId, outcome });
  }
  return out;
}

/**
 * Recovery-only transition wrapper. Re-reads the op fresh from disk,
 * clears any lease columns that may have lingered, and calls
 * `transitionOp` with `clearLeaseFromOp: true` so the transition's
 * writeOp atomically clears the dead worker's lease alongside the
 * state change.
 *
 * Belt and suspenders: `recoverStaleOp` already clears the lease via
 * `persistOpKeepingSignals(op, { preserveLeaseFromDisk: false })`
 * BEFORE this transition, so the disk lease at the moment of write is
 * already null. The atomic clear here defends against any future code
 * path that calls `transitionOp` on an op whose lease was not
 * pre-cleared, and against concurrent writers in v1+ multi-process.
 */
function safeRecoveryTransition(
  opId: string,
  to: Parameters<typeof transitionOp>[1],
  reason: string,
): void {
  const op = readOp(opId);
  if (!op) return;
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = null;
  op.canonical.leaseExpiresAt = null;
  op.workerId = undefined;
  try {
    transitionOp(op, to, reason, { clearLeaseFromOp: true });
  } catch (e) {
    if (e instanceof IllegalTransitionError) return;
    throw e;
  }
}
