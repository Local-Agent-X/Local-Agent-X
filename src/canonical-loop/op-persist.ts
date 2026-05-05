/**
 * Op persistence helper that preserves control-API signal columns
 * (Issue 05).
 *
 * Background. The PRD §9 schema models `pause_requested_at`, `cancel_*`,
 * `redirect_*` as columns on the `ops` row, written by the public control
 * API. In our filesystem mapping, the entire op is serialized to a single
 * `operation.json` via `writeOp`. Worker-side writes (state transitions,
 * lease bookkeeping, checkpoint commits) and control-API writes both
 * target this file, and a naive full-object replace would let one side
 * clobber the other:
 *
 *   t0  control-API: opPause writes pauseRequestedAt=<ts>
 *   t1  worker:      commitTurn writes the in-memory op (signals=null)
 *                    → disk loses the pauseRequestedAt the user just set
 *
 * `persistOpKeepingSignals(op)` is the canonical-loop's writeOp wrapper:
 * before persisting, it reloads the on-disk op and copies its signal
 * columns onto `op`. Loop-side writes that do NOT intend to touch a
 * signal column should use this; control-API writes that DO want to
 * change a signal column use plain `writeOp` after their own RMW.
 *
 * Worker- and state-owned columns (state, status, lease, currentTurnIdx,
 * currentCheckpointId, completedAt, startedAt) are written from `op`
 * as-is — they are owned by the loop, never the control API.
 */
import { readOp, writeOp } from "../workers/op-store.js";
import type { Op } from "../workers/types.js";

export interface PersistOpOptions {
  /**
   * When true, do NOT restore `redirectInstruction` / `redirectReceivedAt`
   * from disk — leaves them as set on the in-memory op. The canonical
   * caller is `commitTurn` clearing the redirect after applying it (Issue
   * 07). Pause and cancel signals are still preserved.
   */
  clearRedirect?: boolean;
  /**
   * When false (default true), the in-memory op's `leaseOwner` /
   * `leaseExpiresAt` columns are persisted as-is — the caller is the
   * lease writer (`lease.ts`) or the recovery primitive that explicitly
   * clears a stale lease.
   *
   * Default behavior: lease columns are restored from disk so writers
   * that DO NOT own the lease (state-machine, checkpoint, control APIs)
   * cannot clobber a lease an active worker is heartbeating (Issue 08).
   */
  preserveLeaseFromDisk?: boolean;
}

export function persistOpKeepingSignals(op: Op, opts: PersistOpOptions = {}): void {
  const onDisk = readOp(op.id);
  const preserveLease = opts.preserveLeaseFromDisk !== false;
  if (onDisk?.canonical) {
    if (!op.canonical) op.canonical = {};
    op.canonical.pauseRequestedAt = onDisk.canonical.pauseRequestedAt ?? null;
    op.canonical.cancelRequestedAt = onDisk.canonical.cancelRequestedAt ?? null;
    if (!opts.clearRedirect) {
      op.canonical.redirectInstruction = onDisk.canonical.redirectInstruction ?? null;
      op.canonical.redirectReceivedAt = onDisk.canonical.redirectReceivedAt ?? null;
    }
    if (preserveLease) {
      op.canonical.leaseOwner = onDisk.canonical.leaseOwner ?? null;
      op.canonical.leaseExpiresAt = onDisk.canonical.leaseExpiresAt ?? null;
    }
  }
  writeOp(op);
}
