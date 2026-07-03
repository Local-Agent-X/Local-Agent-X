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
 *      finally released the lease but before a terminal transition landed). A
 *      `queued` op is ALWAYS reclaimable: the worker dies before the
 *      queued→running transition and never heartbeats, so a persisted
 *      queued+lease is a crashed worker regardless of lease freshness (OP-6 —
 *      see the recoverStaleOp guard for why the fresh-lease skip excludes it).
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
 * Hard rule: lease.ts is the sole writer of lease columns and
 * state-machine.ts is the sole writer of canonical state. recovery.ts
 * orchestrates both — it never mutates either column directly outside
 * those primitives, except for the explicit lease-clear step that runs
 * just before emitting `lease_lost`.
 */
import { existsSync, readdirSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";
import { readOp } from "../ops/op-store.js";
import { decideRecovery, isCircuitOpen, recordFailure } from "../ops/heartbeat.js";
import { emit } from "./event-emitter.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { isLeaseExpired } from "./lease.js";
import { evictWorker, enqueueOp, pumpScheduler } from "./scheduler.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import type { CanonicalLane } from "./types.js";

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
  // OP-6 exception for `queued`: a fresh lease is proof of a live worker ONLY
  // for running/cancelling ops, which heartbeat while driving. A `queued` op
  // has NOT started heartbeating — worker.drive() acquires the lease and
  // transitions queued→running within one fully-synchronous stretch (worker.ts
  // has no `await` between acquireLease and the transition), so no live worker
  // is ever observable in the queued+lease state across a yield. A persisted
  // queued+lease therefore ALWAYS means a worker that crashed in that window,
  // regardless of whether the lease has ticked past expiry yet — never skip it
  // as `lease_fresh`, or a crash-restart inside the lease window strands the op
  // in `queued` forever (the boot sweep runs once).
  const leaseOwner = op.canonical?.leaseOwner ?? null;
  if (state !== "queued" && leaseOwner && !isLeaseExpired(op)) {
    return { ok: false, kind: "lease_fresh" };
  }

  // Drop the scheduler's claim on the (dead) worker so the replacement launch
  // is not blocked by the lane cap. Idempotent; no-op when there was no lease.
  evictWorker(opId);

  if (leaseOwner) {
    // Expired-lease shape: clear the dead lease columns on disk via
    // persistOpKeepingSignals (so we don't clobber control-API signals) BEFORE
    // the `lease_lost` emit, so any consumer reading the op on the event
    // observes the cleared lease. Recovery is one of the two legitimate writers
    // of lease columns (alongside lease.ts) — opt out of disk-preservation so
    // this clear lands.
    if (!op.canonical) op.canonical = {};
    op.canonical.leaseOwner = null;
    op.canonical.leaseExpiresAt = null;
    op.workerId = undefined;
    persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
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
    safeRecoveryTransition(
      opId,
      "cancelled",
      leaseOwner ? "lease_expired_during_cancel" : "orphaned_during_cancel",
    );
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
  recordFailure(op.type);
  if (!decision.shouldRetry || circuitAlreadyOpen) {
    const why = decision.shouldRetry
      ? `circuit breaker open for op type "${op.type}"`
      : decision.reason;
    safeRecoveryTransition(opId, "failed", `recovery_abandoned: ${why}`);
    return { ok: true, kind: "exhausted", expiredWorkerId };
  }

  // This relaunch consumes one recovery attempt. Persist the counter BEFORE
  // the requeue transition (safeRecoveryTransition re-reads from disk) so the
  // next crash of this op sees the incremented count.
  op.attemptCount = (op.attemptCount ?? 0) + 1;
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });

  // running → queued: re-enqueue for a replacement worker, which reads
  // `op_turns` for the resume turnIdx and hands prior `provider_state` to the
  // adapter (PRD §11). Identical to the expired-lease path — recovery's job is
  // to resume, and the op's retryPolicy bounds re-attempts. A commit that threw
  // never persisted its op_turns row, so the replacement re-drives that turn
  // idempotently (checkpoint.ts's `(op_id, turn_idx)` replay guard also absorbs
  // a turn that DID commit before the crash), so this cannot double-execute a
  // committed turn.
  safeRecoveryTransition(opId, "queued", transitionReason);
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
 *   - `op.canonical.state ∈ {running, cancelling, queued}` (paused ops are not
 *     recoverable; terminal states are absorbing). `queued` ops matter because
 *     the scheduler queue is in-memory and vanishes on restart — a disk op
 *     stuck in `queued` at boot has no live worker and no in-memory slot, so it
 *     would stay pending forever without this sweep (OP-6).
 *   - the op has NO LIVE OWNER — for running/cancelling, either the lease is
 *     set AND expired, OR there is no lease at all (the C3 orphan shape; see
 *     recoverStaleOp). A `queued` op has no live owner by construction (see
 *     recoverStaleOp's OP-6 note), so lease freshness does not gate it.
 * and routes each through `recoverStaleOp`.
 *
 * Safe to call exactly once at server boot. No-op if the operations
 * dir is missing. Resilient to per-op read errors (logs and skips).
 *
 * Returns the list of outcomes for logging by the caller.
 */
export function sweepStaleCanonicalOps(): { opId: string; outcome: RecoveryOutcome }[] {
  const opsBase = join(getLaxDir(), "operations");
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
    if (c.state !== "running" && c.state !== "cancelling" && c.state !== "queued") continue;
    // A fresh lease ⇒ a live worker: skip — but ONLY for running/cancelling
    // ops, which heartbeat. A `queued` op never heartbeats, so a persisted
    // queued+lease is a crashed worker regardless of freshness (OP-6) and must
    // NOT be skipped. A no-lease non-terminal op is the C3 orphan shape and IS
    // recoverable. Mirror recoverStaleOp's recoverability test exactly.
    if (c.state !== "queued" && c.leaseOwner && !isLeaseExpired(op)) continue;

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
