/**
 * Crash recovery for canonical-loop ops (Issue 08).
 *
 * When a worker dies mid-turn its lease (`leaseOwner`, `leaseExpiresAt`)
 * stays on disk. After `leaseExpiresAt` passes any worker can take over.
 * `recoverStaleOp` is the canonical primitive that does the takeover
 * bookkeeping:
 *
 *   1. Re-read the op from disk.
 *   2. Verify `state ∈ {running, cancelling, queued}` AND the op has no LIVE
 *      owner. For running/cancelling that means the lease is expired OR there
 *      is no lease at all (the C3 orphan shape: a worker threw after its
 *      finally released the lease but before a terminal transition landed).
 *      A queued op is reclaimable only without an owner or after expiry; a
 *      fresh queued claim may belong to another process and stays protected.
 *      Stop otherwise — terminal ops, paused ops, and running/cancelling ops
 *      holding a FRESH lease (a live worker) are not recoverable.
 *   3. Evict the dead worker from the scheduler's active map (frees a
 *      lane slot for the replacement).
 *   4. Clear the dead lease columns on disk.
 *   5. Emit `lease_lost { workerId, reason: "expired" }` so consumers
 *      observe the death before any state transition.
 *   6. Transition `running → queued` (or `cancelling → cancelled` if the op
 *      was already terminating; PRD §13 cancel always wins). A `queued` op is
 *      already in the target state, so recovery skips the transition and goes
 *      straight to the re-enqueue. The transition emits `state_changed` via
 *      state-machine.
 *   7. Re-enqueue + pump the scheduler (only when the recovery resumes
 *      work — cancelling ops jump straight to `cancelled`).
 *
 * Hard rule: lease.ts is the sole writer of lease columns and state-machine.ts
 * is the sole writer of canonical state. Recovery uses the exact-claim clear
 * under the cross-process op lock before emitting `lease_lost`.
 */
import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";
import { readOp } from "../ops/op-store.js";
import { decideRecovery, isCircuitOpen, recordFailure } from "../ops/heartbeat.js";
import { emit } from "./event-emitter.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { StrictOpPersistenceError } from "./op-persist.js";
import {
  isLeaseExpired,
  leaseClaimFromOp,
  withObservedExpiredLeaseRecovery,
} from "./lease.js";
import { evictWorker, enqueueOp, pumpScheduler } from "./scheduler.js";
import { resolveExpiredPendingApproval } from "./control-api-approvals.js";
import { rehydrateRecoveredRuntime } from "./runtime.js";
import { trackOpForSession } from "../ops/session-bridge.js";
import { releaseAriKernelScope } from "../ari-kernel/index.js";
import type { CanonicalLane } from "./types.js";
import { reconcilePublishedTurnCommitsForRecovery } from "./checkpoint.js";
export type RecoveryOutcomeKind =
  | "recovered"     // running → queued (or an already-queued op that crashed
                    //   before launch), op re-enqueued for a replacement worker.
  | "cancelled"     // cancelling → cancelled, no requeue.
  | "exhausted"     // retry policy / circuit breaker refused a relaunch:
                    // running → failed, no requeue.
  | "no_lease"      // (retained for the type surface) — recoverStaleOp no longer
                    // returns it; a non-terminal no-lease op is now the C3
                    // orphan shape and IS reclaimed. See recoverStaleOp.
  | "lease_fresh"   // lease still in date — leave it alone.
  | "lease_changed" // observation lost a race to a newer exact claim.
  | "lock_unavailable" // strict op lock was contended; retry later.
  | "persistence_failed" // strict recovery write failed; retry later.
  | "not_running"   // op is not in a recoverable state.
  | "unknown_op";   // op id not on disk.

export interface RecoveryOutcome {
  ok: boolean;
  kind: RecoveryOutcomeKind;
  /** Worker id that lost the lease (when applicable). */
  expiredWorkerId?: string;
}

export function recoverStaleOp(opId: string): RecoveryOutcome {
  reconcilePublishedTurnCommitsForRecovery(opId);
  const op = readOp(opId);
  if (!op) return { ok: false, kind: "unknown_op" };
  const state = op.canonical?.state;
  if (state !== "running" && state !== "cancelling" && state !== "queued") {
    return { ok: false, kind: "not_running" };
  }

  // Recoverability: a non-terminal op is recoverable when it has NO LIVE OWNER.
  // Two disk shapes qualify:
  //   1. Expired lease — a worker died mid-turn and its lease timed out (the
  //      classic Issue-08 crash-recovery case).
  //   2. NO lease at all — the C3 orphan class: a worker threw AFTER its
  //      `finally` released the lease but BEFORE a terminal transition landed
  //      (disk-full during commitTurn's transition; a cancel-time throw that
  //      hit the illegal cancelling → failed and was swallowed). Left alone the
  //      op wedges non-terminal forever and the chat pump never sees a terminal
  //      `state_changed`. Recovery is the single chokepoint that closes it.
  //
  // SAFETY — this can NEVER race a live worker. lease.ts writes the lease
  // BEFORE the queued → running transition and heartbeats it; only releaseLease
  // (the worker's `finally`) or recovery ever clears it. So a fresh lease ⇒ the
  // worker is alive (left untouched by the `lease_fresh` guard below), and a
  // non-terminal op with no lease ⇒ no live owner by construction — the absence
  // of the lease IS the staleness signal, there is no expiry window to wait on.
  // An op that just acquired a lease is `running` WITH a fresh lease, so this
  // change can neither double-drive nor double-finalize a live op.
  //
  // Multi-process schedulers can observe the brief queued+lease window. A
  // fresh exact claim is therefore live in every state; a crashed queued op is
  // reclaimed by the periodic sweep after its bounded expiry.
  const observedClaim = leaseClaimFromOp(op);
  if (observedClaim && !isLeaseExpired(op)) {
    return { ok: false, kind: "lease_fresh" };
  }

  const leaseCheck = withObservedExpiredLeaseRecovery(
    opId,
    observedClaim,
    (lockedOp, expiredClaim): RecoveryOutcome => {
      const lockedState = lockedOp.canonical!.state as "running" | "cancelling" | "queued";
      return finishRecoveredOp(opId, lockedOp, lockedState, expiredClaim?.owner ?? null);
    },
    candidate => {
      const candidateState = candidate.canonical?.state;
      return candidateState === "running" || candidateState === "cancelling" || candidateState === "queued";
    },
  );
  if (!leaseCheck.ok) {
    if (leaseCheck.reason === "lease_fresh") return { ok: false, kind: "lease_fresh" };
    if (leaseCheck.reason === "lock_unavailable") return { ok: false, kind: "lock_unavailable" };
    if (leaseCheck.reason === "unknown_op") return { ok: false, kind: "unknown_op" };
    if (leaseCheck.reason === "not_recoverable") return { ok: false, kind: "not_running" };
    if (leaseCheck.reason === "persistence_failed") return { ok: false, kind: "persistence_failed" };
    return { ok: false, kind: "lease_changed" };
  }
  return leaseCheck.value;
}

function finishRecoveredOp(
  opId: string,
  op: NonNullable<ReturnType<typeof readOp>>,
  state: "running" | "cancelling" | "queued",
  leaseOwner: string | null,
): RecoveryOutcome {
  // Rebuild process-local state; op_turn/op_messages remain authoritative.
  rehydrateRecoveredRuntime(op);
  const sessionId = op.canonical?.sessionId;
  if (sessionId) trackOpForSession(op.id, sessionId, op.task);

  // Stale-approval hygiene: the op is dead-owner from here on, so a
  // pendingApproval column whose ask window has already expired can never be
  // answered — durably resolve it as a timeout (delivery: "recorded") so
  // rediscovery APIs never surface a dead approval. A still-live column is
  // preserved: the replacement worker's re-drive re-asks and the approval
  // manager carries the original window over (re-ask continuity). Runs for
  // every recoverable shape, boot sweep included (it routes through here),
  // and BEFORE the persists below — persistOpKeepingSignals always restores
  // pendingApproval from disk, so the clear cannot be clobbered.
  resolveExpiredPendingApproval(opId);

  // Drop the scheduler's claim on the (dead) worker so the replacement launch
  // is not blocked by the lane cap. Idempotent; no-op when there was no lease.
  evictWorker(opId);
  releaseAriKernelScope(opId);
  if (leaseOwner) {
    emit(opId, "lease_lost", { workerId: leaseOwner, reason: "expired" });
  }
  // No-lease (C3 orphan) shape: the worker's own `finally` already cleared the
  // lease and emitted `lease_lost`. Nothing to clear or re-announce — proceed
  // straight to the terminal / re-runnable transition.

  const expiredWorkerId = leaseOwner ?? undefined;

  if (state === "queued") {
    // OP-6: an op persisted as `queued` whose server died before (or during)
    // launch. It never entered its turn loop — the worker crashed in the
    // synchronous acquireLease→queued→running window, or the process died
    // before the scheduler ever pumped it. No turn ran and no provider call was
    // made, so relaunch is fully idempotent: it must NOT consume a recovery
    // attempt or record a circuit-breaker failure (those gate re-running an op
    // that actually executed). The dead lease (if any) is already cleared and
    // `lease_lost` emitted above; the op is already in `queued`, so there is no
    // state transition to make — just re-enqueue for a replacement worker.
    // enqueueOp is idempotent against an op already sitting in the in-memory
    // queue, and clearing the lease first lets the replacement's acquireLease
    // succeed.
    enqueueOp(opId, op.lane as CanonicalLane);
    pumpScheduler();
    return { ok: true, kind: "recovered", expiredWorkerId };
  }

  if (state === "cancelling") {
    // Worker died / threw mid-cancel. PRD §13 cancel always wins — finalize the
    // cancellation instead of resuming. Adapter is gone with the worker, so no
    // further `abort()` is possible; just close the state.
    if (!safeRecoveryTransition(
      opId,
      "cancelled",
      leaseOwner ? "lease_expired_during_cancel" : "orphaned_during_cancel",
    )) return { ok: false, kind: "persistence_failed", expiredWorkerId };
    return { ok: true, kind: "cancelled", expiredWorkerId };
  }

  // Bounded recovery (spec §18/§20 + §21.4) — the op's per-type retryPolicy
  // and the per-type circuit breaker gate the relaunch at this single
  // chokepoint. Each recovery IS one observed crash of this op: it consumes
  // one attempt against `retryPolicy.maxRecoveryAttempts` and records one
  // failure toward the type's rolling-window breaker. Without the cap a
  // poison op loops lease-expire → recover → relaunch forever, holding a
  // lane slot on every cycle. `committingCallsAlreadyMade` is false because
  // replay here is idempotent (see the requeue paragraph below); backoffMs
  // is intentionally NOT honored at this seam — an in-memory delay timer
  // would strand the op in `queued` if the process died mid-delay, and the
  // lease duration already paces recovery cycles.
  const transitionReason = leaseOwner ? "lease_expired" : "orphaned_no_lease";
  const circuitAlreadyOpen = isCircuitOpen(op.type);
  const decision = decideRecovery(op, {
    committingCallsAlreadyMade: false,
    reason: transitionReason,
  });
  if (!decision.shouldRetry || circuitAlreadyOpen) {
    const why = decision.shouldRetry
      ? `circuit breaker open for op type "${op.type}"`
      : decision.reason;
    if (!safeRecoveryTransition(opId, "failed", `recovery_abandoned: ${why}`)) {
      return { ok: false, kind: "persistence_failed", expiredWorkerId };
    }
    recordFailure(op.type);
    return { ok: true, kind: "exhausted", expiredWorkerId };
  }

  // Counter + running->queued transition are one strict write. A failed rename
  // leaves the ownerless running row recoverable without consuming an attempt.
  op.attemptCount = (op.attemptCount ?? 0) + 1;
  // Persist before re-enqueue so a replacement reads the fenced attempt/state.
  if (!safeRecoveryTransition(opId, "queued", transitionReason, op)) {
    return { ok: false, kind: "persistence_failed", expiredWorkerId };
  }
  recordFailure(op.type);
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
 * Every canonical op first repairs committed-turn evidence. Only ownerless
 * running/cancelling/queued ops proceed to state recovery; pause and terminal
 * control remains authoritative.
 *
 * Safe to call once at server boot. Periodic callers must use the cooperative
 * sweep below so operation history cannot starve worker heartbeats. No-op if
 * the operations dir is missing. Resilient to per-op read errors (logs and skips).
 *
 * Returns the list of outcomes for logging by the caller.
 */
export function sweepStaleCanonicalOps(): { opId: string; outcome: RecoveryOutcome }[] {
  const opIds = listOperationIds();
  const out: { opId: string; outcome: RecoveryOutcome }[] = [];
  for (const opId of opIds) {
    let op;
    try { op = readOp(opId); } catch { continue; }
    if (!op) continue;
    const c = op.canonical;
    if (!c || c.flagValue !== true) continue;
    reconcilePublishedTurnCommitsForRecovery(opId);
    op = readOp(opId);
    if (!op?.canonical) continue;
    const refreshed = op.canonical;
    if (refreshed.state !== "running" && refreshed.state !== "cancelling" && refreshed.state !== "queued") continue;
    // A fresh exact claim may be live in any state. Ownerless non-terminal ops
    // and expired claims remain recoverable.
    if (refreshed.leaseOwner && !isLeaseExpired(op)) continue;

    const outcome = recoverStaleOp(opId);
    out.push({ opId, outcome });
  }
  return out;
}

const COOPERATIVE_BATCH_SIZE = 16, COOPERATIVE_TIME_SLICE_MS = 8;

export interface CooperativeRecoverySweepOptions {
  batchSize?: number;
  timeSliceMs?: number;
  listOpIds?: () => string[] | Promise<string[]>;
  readCandidate?: typeof readOp;
  recoverCandidate?: typeof recoverStaleOp;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
}

/**
 * Periodic stale-op sweep. It bounds both candidate count and synchronous work
 * time per slice, yielding between slices so lease heartbeats keep running.
 * Candidate reads only identify canonical active ops; recoverStaleOp re-reads
 * the op immediately before acting and remains the authoritative lease gate.
 */
export async function sweepStaleCanonicalOpsCooperatively(
  options: CooperativeRecoverySweepOptions = {},
): Promise<{ opId: string; outcome: RecoveryOutcome }[]> {
  const batchSize = options.batchSize ?? COOPERATIVE_BATCH_SIZE;
  const timeSliceMs = options.timeSliceMs ?? COOPERATIVE_TIME_SLICE_MS;
  if (batchSize <= 0 || timeSliceMs <= 0) {
    throw new Error("Cooperative recovery sweep bounds must be positive");
  }

  const opIds = await (options.listOpIds ?? listOperationIdsAsync)();
  const readCandidate = options.readCandidate ?? readOp;
  const recoverCandidate = options.recoverCandidate ?? recoverStaleOp;
  const now = options.now ?? Date.now;
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldRecoverySlice;
  const out: { opId: string; outcome: RecoveryOutcome }[] = [];
  let sliceStartedAt = now();
  let sliceCount = 0;

  for (let index = 0; index < opIds.length; index++) {
    const opId = opIds[index];
    let op;
    try { op = readCandidate(opId); } catch { op = null; }
    if (op?.canonical?.flagValue === true) {
      reconcilePublishedTurnCommitsForRecovery(opId);
      try { op = readCandidate(opId); } catch { op = null; }
    }
    const state = op?.canonical?.state;
    if (
      op?.canonical?.flagValue === true
      && (state === "running" || state === "cancelling" || state === "queued")
    ) {
      const outcome = recoverCandidate(opId);
      if (outcome.ok) out.push({ opId, outcome });
    }

    sliceCount += 1;
    const moreRemain = index + 1 < opIds.length;
    if (moreRemain && (sliceCount >= batchSize || now() - sliceStartedAt >= timeSliceMs)) {
      await yieldToEventLoop();
      sliceCount = 0;
      sliceStartedAt = now();
    }
  }
  return out;
}

function listOperationIds(): string[] {
  const opsBase = join(getLaxDir(), "operations");
  if (!existsSync(opsBase)) return [];
  try { return readdirSync(opsBase); } catch { return []; }
}
async function listOperationIdsAsync(): Promise<string[]> {
  const opsBase = join(getLaxDir(), "operations");
  try { return await readdir(opsBase); } catch { return []; }
}
function yieldRecoverySlice(): Promise<void> {
  return new Promise((resolve) => {
    const immediate = setImmediate(resolve);
    immediate.unref();
  });
}

/** Recovery-only transition wrapper. The exact stale claim was already
 * cleared under the strict lease lock; ordinary persistence preserves any
 * newer claim that arrived after that point. */
function safeRecoveryTransition(
  opId: string,
  to: Parameters<typeof transitionOp>[1],
  reason: string,
  candidate?: NonNullable<ReturnType<typeof readOp>>,
): boolean {
  const op = candidate ?? readOp(opId);
  if (!op) return false;
  try {
    transitionOp(op, to, reason, { strictPersistence: true });
    return true;
  } catch (e) {
    if (e instanceof IllegalTransitionError) return false;
    if (e instanceof StrictOpPersistenceError) return false;
    throw e;
  }
}
