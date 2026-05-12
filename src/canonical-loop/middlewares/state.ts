/**
 * Per-op middleware state registry.
 *
 * agent-loop keeps middleware state in `WeakMap<LoopContext, State>` because
 * one LoopContext spans the entire turn (every iteration shares it).
 * Canonical builds a fresh `CanonicalLoopContext` per turn (one driveTurn
 * call), so a WeakMap on the context can't hold state across turns.
 *
 * Instead, we key by `opId`. The op IS the across-turn boundary the legacy
 * loop got "for free" from the long-lived LoopContext. State is dropped via
 * `clearMiddlewareStateForOp` from the op-terminal hook in event-emitter.ts
 * so a long-running process doesn't leak.
 */

const STATES = new Map<string, Map<string, unknown>>();

export function getMiddlewareState<T>(opId: string, name: string, init: () => T): T {
  let bucket = STATES.get(opId);
  if (!bucket) {
    bucket = new Map();
    STATES.set(opId, bucket);
  }
  let s = bucket.get(name) as T | undefined;
  if (s === undefined) {
    s = init();
    bucket.set(name, s);
  }
  return s;
}

/** Test/runtime hook — drop all per-op middleware state. Safe to call
 *  repeatedly; idempotent if no state was registered for the op. */
export function clearMiddlewareStateForOp(opId: string): void {
  STATES.delete(opId);
}

/** Test-only: drop every op's state. Used by test harnesses between cases. */
export function _resetMiddlewareStates(): void {
  STATES.clear();
}
