/** Cross-process op lease ownership and expiry. */
import { readOp, tryWithOpLock } from "../ops/op-store.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import type { Op } from "../ops/types.js";

export interface LeaseConfig {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
}

export interface LeaseClaim {
  owner: string;
  generation: number;
}

export type LeaseAcquireResult =
  | { ok: true; claim: LeaseClaim }
  | { ok: false; reason: "unknown_op" | "held" | "lock_unavailable" | "generation_exhausted" };

export type LeaseActionResult =
  | { ok: true }
  | { ok: false; reason: "unknown_op" | "claim_lost" | "lock_unavailable" };

export type LeaseRecoveryResult =
  | { ok: true; op: Op; expiredClaim: LeaseClaim | null }
  | { ok: false; reason: "unknown_op" | "claim_changed" | "lease_fresh" | "lock_unavailable" | "not_recoverable" };

export type LeaseRecoveryRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unknown_op" | "claim_changed" | "lease_fresh" | "lock_unavailable" | "not_recoverable" };

const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
};

let CONFIG: LeaseConfig = { ...DEFAULT_LEASE_CONFIG };
type LeaseRacePoint = "before_acquire_lock" | "before_recovery_lock";
let raceHook: ((point: LeaseRacePoint) => void) | null = null;

export function getLeaseConfig(): LeaseConfig {
  return { ...CONFIG };
}

export function setLeaseConfig(partial: Partial<LeaseConfig>): void {
  CONFIG = { ...CONFIG, ...partial };
}

export function resetLeaseConfig(): void {
  CONFIG = { ...DEFAULT_LEASE_CONFIG };
  raceHook = null;
}

/** Test-only deterministic seam for changing the row between observation and lock. */
export function _setLeaseRaceHookForTest(hook: ((point: LeaseRacePoint) => void) | null): void {
  raceHook = hook;
}

/** A fresh owner, including the same worker id, is already a distinct claim.
 * Callers refresh only by presenting the exact claim to heartbeatLease. */
export function acquireLease(opId: string, workerId: string): LeaseAcquireResult {
  raceHook?.("before_acquire_lock");
  const locked = tryWithOpLock(opId, (): LeaseAcquireResult => {
    const op = readOp(opId);
    if (!op) return { ok: false, reason: "unknown_op" };
    if (!op.canonical) op.canonical = {};
    const current = leaseClaimFromOp(op);
    if (current && !isLeaseExpired(op)) return { ok: false, reason: "held" };

    const generation = persistedGeneration(op) + 1;
    if (!Number.isSafeInteger(generation)) return { ok: false, reason: "generation_exhausted" };
    const claim = { owner: workerId, generation };
    op.canonical.leaseOwner = claim.owner;
    op.canonical.leaseGeneration = claim.generation;
    op.canonical.leaseExpiresAt = newExpiry();
    op.workerId = workerId;
    persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
    return { ok: true, claim };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "lock_unavailable" };
}

export function heartbeatLease(opId: string, claim: LeaseClaim): LeaseActionResult {
  const locked = tryWithOpLock(opId, (): LeaseActionResult => {
    const op = readOp(opId);
    if (!op) return { ok: false, reason: "unknown_op" };
    if (!sameClaim(leaseClaimFromOp(op), claim)) return { ok: false, reason: "claim_lost" };
    op.canonical!.leaseExpiresAt = newExpiry();
    persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
    return { ok: true };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "lock_unavailable" };
}

export function releaseLease(opId: string, claim: LeaseClaim): LeaseActionResult {
  const locked = tryWithOpLock(opId, (): LeaseActionResult => {
    const op = readOp(opId);
    if (!op) return { ok: false, reason: "unknown_op" };
    if (!sameClaim(leaseClaimFromOp(op), claim)) return { ok: false, reason: "claim_lost" };
    op.canonical!.leaseOwner = null;
    op.canonical!.leaseExpiresAt = null;
    op.workerId = undefined;
    persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
    return { ok: true };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "lock_unavailable" };
}

/** Re-check an observed claim under the strict op lock and clear only that
 * expired generation. A null observation proves the row is still ownerless. */
export function clearObservedExpiredLease(
  opId: string,
  observed: LeaseClaim | null,
): LeaseRecoveryResult {
  const result = withObservedExpiredLeaseRecovery(opId, observed, (op, expiredClaim) => ({
    ok: true as const,
    op,
    expiredClaim,
  }));
  return result.ok ? result.value : result;
}

/** Keep recovery bookkeeping under the same strict lock as the exact clear.
 * Reentrant op persistence remains serialized; a replacement cannot acquire
 * until the callback has committed the recovered state. */
export function withObservedExpiredLeaseRecovery<T>(
  opId: string,
  observed: LeaseClaim | null,
  recover: (op: Op, expiredClaim: LeaseClaim | null) => T,
  canRecover: (op: Op) => boolean = () => true,
): LeaseRecoveryRunResult<T> {
  raceHook?.("before_recovery_lock");
  const locked = tryWithOpLock(opId, (): LeaseRecoveryRunResult<T> => {
    const op = readOp(opId);
    if (!op) return { ok: false, reason: "unknown_op" };
    const current = leaseClaimFromOp(op);
    if (!sameClaim(current, observed)) return { ok: false, reason: "claim_changed" };
    if (current && !isLeaseExpired(op)) return { ok: false, reason: "lease_fresh" };
    if (!canRecover(op)) return { ok: false, reason: "not_recoverable" };
    const malformedOwner = op.canonical?.leaseOwner != null && current === null;
    if (current || malformedOwner) {
      if (!op.canonical) op.canonical = {};
      op.canonical!.leaseOwner = null;
      op.canonical!.leaseExpiresAt = null;
      op.workerId = undefined;
      persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
    }
    return { ok: true, value: recover(op, current) };
  });
  return locked.acquired ? locked.value : { ok: false, reason: "lock_unavailable" };
}

export function leaseClaimFromOp(op: Op | null | undefined): LeaseClaim | null {
  const owner = op?.canonical?.leaseOwner;
  if (typeof owner !== "string" || owner.length === 0) return null;
  return { owner, generation: persistedGeneration(op) };
}

export function isLeaseExpired(op: Op | null | undefined): boolean {
  const expiresAt = op?.canonical?.leaseExpiresAt;
  if (!expiresAt) return leaseClaimFromOp(op) !== null;
  const ms = Date.parse(expiresAt);
  return !Number.isFinite(ms) || ms <= Date.now();
}

function persistedGeneration(op: Op | null | undefined): number {
  const value = op?.canonical?.leaseGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sameClaim(a: LeaseClaim | null, b: LeaseClaim | null): boolean {
  return a === null || b === null
    ? a === b
    : a.owner === b.owner && a.generation === b.generation;
}

function newExpiry(): string {
  return new Date(Date.now() + CONFIG.leaseDurationMs).toISOString();
}
