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
import { writeOp } from "../workers/op-store.js";
import { emit } from "./event-emitter.js";
import type { Op, OpStatus } from "../workers/types.js";
import type { CanonicalEvent, CanonicalState } from "./types.js";

const TRANSITIONS: Record<CanonicalState, ReadonlySet<CanonicalState>> = {
  // queued → failed covers system-level fast-fail (no adapter configured for
  // the op's lane/provider). Per-turn errors still go via running → failed.
  queued:     new Set<CanonicalState>(["running", "failed"]),
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

/**
 * Transition `op` from its current canonical state to `to`.
 * Throws on illegal transitions. Mutates the op, persists it, emits the
 * `state_changed` event with body `{ from, to, reason }`.
 */
export function transitionOp(op: Op, to: CanonicalState, reason: string): CanonicalEvent {
  const from = op.canonical?.state;
  if (from === undefined) throw new IllegalTransitionError(from, to);
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) throw new IllegalTransitionError(from, to);

  if (!op.canonical) op.canonical = {};
  op.canonical.state = to;
  op.status = LEGACY_STATUS[to];
  if (to === "running" && !op.startedAt) op.startedAt = new Date().toISOString();
  if (TERMINAL.has(to) && !op.completedAt) op.completedAt = new Date().toISOString();
  writeOp(op);

  return emit(op.id, "state_changed", { from, to, reason });
}

export function isTerminalCanonicalState(s: CanonicalState): boolean {
  return TERMINAL.has(s);
}
