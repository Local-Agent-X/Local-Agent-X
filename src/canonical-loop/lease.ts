/**
 * Op-level lease primitives (Issue 08).
 *
 * Workers hold a time-bounded ownership claim over an op (PRD §14). The
 * lease columns on `ops` (`leaseOwner`, `leaseExpiresAt`) are the source
 * of truth — disk overrides any in-memory worker state. A worker that
 * died mid-turn leaves its lease behind; a janitor or a re-leasing
 * worker observes `leaseExpiresAt < now()` and recovers the op (see
 * recovery.ts).
 *
 * Hard rules:
 *   - lease.ts is the SOLE writer of `leaseOwner` / `leaseExpiresAt`.
 *     state-machine.ts, checkpoint.ts, and worker.ts go through these
 *     primitives — they never touch the columns directly.
 *   - Each call re-reads the op from disk before mutating to be defensive
 *     against the (in v1, theoretically forbidden) concurrent-writer race.
 *   - `releaseLease` is a no-op when another worker has acquired the lease
 *     (e.g., after recovery rolled the op forward). The original holder
 *     does not clobber the new owner's columns.
 *
 * v1 single-process semantics. Multi-process replication is out of scope.
 */
import { readOp } from "../workers/op-store.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import type { Op } from "../workers/types.js";

export interface LeaseConfig {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  // PRD §21 defaults: 30s lease, 10s heartbeat (one third of lease).
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
};

let CONFIG: LeaseConfig = { ...DEFAULT_LEASE_CONFIG };

export function getLeaseConfig(): LeaseConfig {
  return { ...CONFIG };
}

/** Tests use this to compress lease/heartbeat for fast iteration. */
export function setLeaseConfig(partial: Partial<LeaseConfig>): void {
  CONFIG = { ...CONFIG, ...partial };
}

export function resetLeaseConfig(): void {
  CONFIG = { ...DEFAULT_LEASE_CONFIG };
}

/**
 * Atomic-ish lease acquisition. Returns true if `workerId` now owns the
 * lease, false if another worker holds a fresh (un-expired) one.
 *
 * Preconditions: the canonical-loop scheduler enforces lane caps and FIFO
 * within lane, so contention on a single op is rare; this primitive
 * exists to detect stale leases left by a crashed worker.
 *
 * Behavior:
 *   - Re-reads the op from disk for the current lease state.
 *   - If `leaseOwner === workerId`, refreshes the expiry (rare reuse path).
 *   - If `leaseOwner` is set and `leaseExpiresAt > now()`, returns false.
 *   - Otherwise overwrites with `(workerId, now + leaseDurationMs)` and
 *     persists via `persistOpKeepingSignals` to avoid clobbering control
 *     signal columns.
 */
export function acquireLease(opId: string, workerId: string): boolean {
  const op = readOp(opId);
  if (!op) return false;
  if (!op.canonical) op.canonical = {};
  const sameOwner = op.canonical.leaseOwner === workerId;
  const heldBySomeoneElse = op.canonical.leaseOwner != null && !sameOwner;
  if (heldBySomeoneElse && !isLeaseExpiredFromExpiresAt(op.canonical.leaseExpiresAt)) {
    return false;
  }
  op.canonical.leaseOwner = workerId;
  op.canonical.leaseExpiresAt = newExpiry();
  op.workerId = workerId;
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
  return true;
}

/**
 * Bump `leaseExpiresAt` by `leaseDurationMs` from now. Returns true if
 * the lease is still owned by `workerId`; false means another worker
 * stole the lease (recovery path) or the op disappeared. Caller (worker
 * heartbeat) should treat false as "abort the in-flight turn".
 */
export function heartbeatLease(opId: string, workerId: string): boolean {
  const op = readOp(opId);
  if (!op) return false;
  if (op.canonical?.leaseOwner !== workerId) return false;
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseExpiresAt = newExpiry();
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
  return true;
}

/**
 * Release the lease iff `workerId` still owns it. Returns true if the
 * release happened, false if someone else owns it now (recovery path)
 * or the op vanished. Worker `finally` blocks use the return value to
 * decide whether to emit a `lease_lost` event — recovery already emitted
 * one.
 */
export function releaseLease(opId: string, workerId: string): boolean {
  const op = readOp(opId);
  if (!op) return false;
  if (op.canonical?.leaseOwner !== workerId) return false;
  if (!op.canonical) op.canonical = {};
  op.canonical.leaseOwner = null;
  op.canonical.leaseExpiresAt = null;
  op.workerId = undefined;
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: false });
  return true;
}

export function isLeaseExpired(op: Op | null | undefined): boolean {
  return isLeaseExpiredFromExpiresAt(op?.canonical?.leaseExpiresAt);
}

function isLeaseExpiredFromExpiresAt(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms <= Date.now();
}

function newExpiry(): string {
  return new Date(Date.now() + CONFIG.leaseDurationMs).toISOString();
}
