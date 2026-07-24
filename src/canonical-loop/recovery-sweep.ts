/**
 * Bulk stale-op sweeps over the on-disk operations store. Split from
 * recovery.ts (400-LOC gate); recoverStaleOp remains the single takeover
 * primitive there — this module only decides WHICH ops pay for repair
 * and recovery, and how the work is paced.
 */
import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { readOp } from "../ops/op-store.js";
import { isLeaseExpired } from "./lease.js";
import { rebuildDependencyScheduling } from "./scheduler.js";
import { reconcilePublishedTurnCommitsForRecovery } from "./checkpoint.js";
import { recoverStaleOp, type RecoveryOutcome } from "./recovery.js";

/**
 * Boot-time sweep of stale canonical-loop ops on disk.
 *
 * When the server gets SIGTERM mid-op, the worker dies but the lease
 * row on disk still says `running` with a now-expired `leaseExpiresAt`.
 * Without this sweep, that op stays "running" forever — no janitor, no
 * re-acquire, just an orphan polluting the AGENTS sidebar and the
 * `op_status` listing until something explicitly drives recovery.
 *
 * Only NON-TERMINAL canonical ops (running/cancelling/queued) repair
 * committed-turn evidence before recovery — a terminal state proves
 * finalize completed, so those projections need no crash repair.
 * Reconciling terminal ops re-projected every historical turn artifact of
 * every op ever run on every sweep (~167-216s/pass at ~420 finished ops),
 * blocking boot for minutes and keeping the 30s janitor permanently
 * mid-sweep. Pause and terminal control remains authoritative.
 *
 * Safe to call once at server boot. Periodic callers must use the cooperative
 * sweep below so operation history cannot starve worker heartbeats. No-op if
 * the operations dir is missing. Resilient to per-op read errors (logs and skips).
 *
 * Returns the list of outcomes for logging by the caller.
 */
export function sweepStaleCanonicalOps(): { opId: string; outcome: RecoveryOutcome }[] {
  rebuildDependencyScheduling();
  const opIds = listOperationIds();
  const out: { opId: string; outcome: RecoveryOutcome }[] = [];
  for (const opId of opIds) {
    let op;
    try { op = readOp(opId); } catch { continue; }
    if (!op) continue;
    const c = op.canonical;
    if (!c || c.flagValue !== true) continue;
    if (c.state !== "running" && c.state !== "cancelling" && c.state !== "queued") continue;
    reconcilePublishedTurnCommitsForRecovery(opId);
    op = readOp(opId);
    if (!op?.canonical) continue;
    const refreshed = op.canonical;
    // Re-check after reconcile: projection repair can surface a terminal turn.
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
  reconcileCandidate?: typeof reconcilePublishedTurnCommitsForRecovery;
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
  const reconcileCandidate = options.reconcileCandidate ?? reconcilePublishedTurnCommitsForRecovery;
  const now = options.now ?? Date.now;
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldRecoverySlice;
  const out: { opId: string; outcome: RecoveryOutcome }[] = [];
  let sliceStartedAt = now();
  let sliceCount = 0;

  for (let index = 0; index < opIds.length; index++) {
    const opId = opIds[index];
    let op;
    try { op = readCandidate(opId); } catch { op = null; }
    // Same terminal-op gate as the sync sweep above (see its doc comment).
    const active = (s: unknown): boolean => s === "running" || s === "cancelling" || s === "queued";
    if (op?.canonical?.flagValue === true && active(op.canonical.state)) {
      reconcileCandidate(opId);
      try { op = readCandidate(opId); } catch { op = null; }
    }
    if (
      op?.canonical?.flagValue === true
      && active(op.canonical.state)
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
