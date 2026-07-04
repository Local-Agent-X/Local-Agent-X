/**
 * Non-blocking advisory resource-lock held-set for the canonical-loop scheduler.
 *
 * A process-global set of the singleton resources currently held by an in-flight
 * op. The one real, non-redundant case today is the single local GPU: two ops
 * that both route to the local model provider (Ollama, maxConcurrent=1) would
 * otherwise contend on `gpu:0`. Ops declare the resources they need via
 * `Op.resourceLocks`; the scheduler serializes ops that share a held key.
 *
 * ADVISORY + NON-BLOCKING by design: an op whose lock is already held is
 * SKIPPED and left in the queue (the scheduler tries later ops, then retries it
 * on the next pump when the lock releases) — it is NEVER awaited. This is
 * deliberately NOT the `withProjectLock` / op-store / browser-mutex promise
 * chain: those block/await a turn. The scheduler must never block its pump, so
 * it needs a synchronous "is this busy right now?" check instead of a lock it
 * can wait on. Releasing a lock triggers a re-pump so a skipped op gets retried.
 *
 * Single-holder invariant: because the scheduler acquires a lock in the same
 * synchronous pump pass in which it checks `anyHeld` (JS is single-threaded and
 * the pump self-guards with a `pumping` flag), two ops can never both hold the
 * same key. A plain Set — not a refcount — is therefore correct.
 *
 * Undefined/empty `locks` are always no-ops: an op with no declared locks is
 * never gated and never touches this set, so existing behavior for every
 * lock-free op is byte-unchanged.
 */

const held = new Set<string>();

/** True if ANY lock in `locks` is currently held by an in-flight op. */
export function anyHeld(locks: string[] | undefined): boolean {
  if (!locks || locks.length === 0) return false;
  for (const l of locks) {
    if (held.has(l)) return true;
  }
  return false;
}

/** Mark every lock in `locks` as held. Pair with `release`. No-op if empty. */
export function acquire(locks: string[] | undefined): void {
  if (!locks) return;
  for (const l of locks) held.add(l);
}

/** Release every lock in `locks`. Idempotent (Set.delete of an absent key is a
 *  no-op). No-op if empty. */
export function release(locks: string[] | undefined): void {
  if (!locks) return;
  for (const l of locks) held.delete(l);
}

/** Test helper — drop all held locks so suites start from a clean set. */
export function resetResourceLocks(): void {
  held.clear();
}
