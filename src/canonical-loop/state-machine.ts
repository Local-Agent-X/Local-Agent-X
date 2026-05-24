/**
 * Canonical state machine (PRD §10).
 *
 * Sole writer of `op.canonical.state`. Validates transitions, syncs the
 * legacy `op.status` for callers using the existing public surface, persists
 * the op via writeOp, and emits the `state_changed` canonical event.
 *
 * Issue 03 exercises queued→running and running→{succeeded,failed}.
 * Subsequent issues activate paused / cancelling / cancelled / re-leasing.
 *
 * Hard rule: nothing outside canonical-loop calls transitionOp(). Adapters,
 * workers (other than via this module), and the public control API never
 * write `canonical.state` directly.
 */
import { emit, clearEmittedErrorsForOp } from "./event-emitter.js";
import { persistOpKeepingSignals } from "./op-persist.js";
import { clearMiddlewareStateForOp } from "./middlewares/state.js";
import { clearEvidenceHistory } from "./middlewares/evidence-history.js";
import type { Op, OpStatus } from "../ops/types.js";
import type { CanonicalEvent, CanonicalState } from "./types.js";

const TRANSITIONS: Record<CanonicalState, ReadonlySet<CanonicalState>> = {
  // queued → failed covers system-level fast-fail (no adapter configured for
  // the op's lane/provider). Per-turn errors still go via running → failed.
  // queued → cancelled covers pre-lease cancel (op cancelled before a worker
  // ever leases it).
  queued:     new Set<CanonicalState>(["running", "failed", "cancelled"]),
  running:    new Set<CanonicalState>(["paused", "cancelling", "succeeded", "failed", "queued"]),
  paused:     new Set<CanonicalState>(["queued"]),
  cancelling: new Set<CanonicalState>(["cancelled"]),
  cancelled:  new Set<CanonicalState>(),
  succeeded:  new Set<CanonicalState>(),
  failed:     new Set<CanonicalState>(),
};

const LEGACY_STATUS: Record<CanonicalState, OpStatus> = {
  queued: "pending",
  running: "running",
  paused: "paused",
  cancelling: "running",
  cancelled: "cancelled",
  succeeded: "completed",
  failed: "failed",
};

const TERMINAL: ReadonlySet<CanonicalState> = new Set(["succeeded", "failed", "cancelled"]);

export class IllegalTransitionError extends Error {
  constructor(public readonly from: CanonicalState | undefined, public readonly to: CanonicalState) {
    super(`illegal canonical state transition: ${from ?? "<unset>"} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export interface TransitionOptions {
  /**
   * When true, the in-memory op's `leaseOwner` / `leaseExpiresAt` columns
   * are persisted as-is — the on-disk lease is NOT restored. Used by the
   * crash-recovery path (Issue 08) so the state transition atomically
   * clears the dead worker's lease alongside the state change. Without
   * this, the default `persistOpKeepingSignals` behavior would restore
   * the stale on-disk lease and leave a recovered op with the dead
   * worker's `leaseOwner` set.
   *
   * Default behavior (lease preserved from disk) is correct for every
   * non-recovery transition: state-machine writers do not own the lease
   * columns and must not clobber a live worker's heartbeated lease.
   */
  clearLeaseFromOp?: boolean;
}

/**
 * Transition `op` from its current canonical state to `to`.
 * Throws on illegal transitions. Mutates the op, persists it, emits the
 * `state_changed` event with body `{ from, to, reason }`.
 */
export function transitionOp(
  op: Op,
  to: CanonicalState,
  reason: string,
  opts: TransitionOptions = {},
): CanonicalEvent {
  const from = op.canonical?.state;
  if (from === undefined) throw new IllegalTransitionError(from, to);
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) throw new IllegalTransitionError(from, to);

  if (!op.canonical) op.canonical = {};
  op.canonical.state = to;
  op.status = LEGACY_STATUS[to];
  if (to === "running" && !op.startedAt) op.startedAt = new Date().toISOString();
  if (TERMINAL.has(to) && !op.completedAt) op.completedAt = new Date().toISOString();
  if (TERMINAL.has(to)) {
    // Drop per-op middleware state + evidence history on terminal so the
    // canonical-loop registries don't grow unbounded across the process
    // lifetime. Safe to call repeatedly (no-op if state was never set for
    // this op).
    clearMiddlewareStateForOp(op.id);
    clearEvidenceHistory(op.id);
    clearEmittedErrorsForOp(op.id);
  }
  // Loop-side write — preserve control-API signal columns from disk so a
  // concurrent opPause/opCancel/etc. is not clobbered. `clearLeaseFromOp`
  // (recovery-only) inverts the default lease preservation so the
  // transition's writeOp clears the stale lease atomically.
  persistOpKeepingSignals(op, { preserveLeaseFromDisk: !opts.clearLeaseFromOp });

  return emit(op.id, "state_changed", { from, to, reason });
}

export function isTerminalCanonicalState(s: CanonicalState): boolean {
  return TERMINAL.has(s);
}
