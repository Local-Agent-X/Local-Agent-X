// Compaction circuit breaker + the forced-compaction marker for the turn loop.
// Split out of compact-history.ts (which stays the CanonicalMessage adapter +
// splitter) so both files clear the 400-LOC gate; compact-history re-exports
// the two public entry points so callers are unaffected.
//
// A session whose context is irrecoverably over the summarizer's own limits
// fails the summarize call every turn, forever — each retry burns up to two
// 30s LLM calls for nothing (the rewrite guard may retry a degenerate output).
// After TRIP_THRESHOLD consecutive failed attempts for an op the breaker trips
// and compactHistory skips the attempt on later calls — but not forever: a
// transient provider outage must not disable summarization for a long-lived
// op's whole life. While tripped, every PROBE_INTERVAL-th otherwise-skipped
// call runs the normal full path once as a recovery probe. A probe whose
// summarize attempt succeeds fully resets the breaker (entry deleted — a later
// failure streak needs TRIP_THRESHOLD fresh failures to re-trip); an
// enabled-null re-trips immediately (no 3-strike grace, no re-logged error —
// debug only) and starts the next skip window. Any successful compaction
// resets the count.
//
// What counts as a FAILED attempt: we decided to compact (over threshold, safe
// split point) and summarizeOldMessages returned null WHILE ENABLED. The
// LAX_LLM_COMPACTION=0 kill switch (classify-with-llm.ts) is an intentional
// off-switch, not an error loop — it never counts (the caller applies that
// exclusion). A structural no-op (under threshold, or no safe split) never
// touches the counter either way.
//
// State is per-op, in-memory, bounded (mirrors memory/extraction-coalescer.ts):
// cap entries, evict the oldest-touched when full. Callers without an opId
// (direct/test callers) bypass the breaker entirely — stateless as before.

import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.compact-history");

const TRIP_THRESHOLD = 3;
// While tripped, every PROBE_INTERVAL-th otherwise-skipped call re-attempts.
const PROBE_INTERVAL = 10;
const MAX_TRACKED_OPS = 500;

interface BreakerEntry {
  failures: number;
  tripped: boolean;
  /** Calls short-circuited since the trip (or since the last consumed probe). */
  skipsSinceTrip: number;
  touchedAt: number;
}

const breakers = new Map<string, BreakerEntry>();

function getBreaker(opId: string): BreakerEntry {
  let b = breakers.get(opId);
  if (!b) {
    if (breakers.size >= MAX_TRACKED_OPS) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, e] of breakers) {
        if (e.touchedAt < oldestAt) { oldestAt = e.touchedAt; oldestKey = key; }
      }
      if (oldestKey !== undefined) breakers.delete(oldestKey);
    }
    b = { failures: 0, tripped: false, skipsSinceTrip: 0, touchedAt: Date.now() };
    breakers.set(opId, b);
  }
  b.touchedAt = Date.now();
  return b;
}

/**
 * Gate at the top of a compaction attempt. `skip` means short-circuit without
 * summarizing; `tripped` reports the pre-attempt state so a later success can
 * surface the recovery once.
 *
 * The probe window is consumed only where a summarize attempt actually
 * resolves (a probe failure resets skipsSinceTrip; a success deletes the
 * entry): a probe that turns out structurally unneeded (under threshold, no
 * safe split) or kill-switch-disabled leaves the counter parked one shy of the
 * interval, so the NEXT eligible call probes instead of waiting out a fresh
 * window — the probe only counts once summarize actually ran.
 */
export function breakerGate(opId: string | undefined, forced: boolean): { skip: boolean; tripped: boolean } {
  const b = opId ? breakers.get(opId) : undefined;
  if (!b?.tripped || forced) return { skip: false, tripped: !!b?.tripped };
  b.touchedAt = Date.now();
  if (b.skipsSinceTrip + 1 < PROBE_INTERVAL) {
    b.skipsSinceTrip += 1;
    logger.debug(`compaction breaker open for op ${opId}; skipping summarize attempt`);
    return { skip: true, tripped: true };
  }
  logger.debug(`compaction breaker probing for op ${opId} after ${b.skipsSinceTrip} skipped calls`);
  return { skip: false, tripped: true };
}

export function recordBreakerFailure(opId: string): void {
  const b = getBreaker(opId);
  b.failures += 1;
  if (b.tripped) {
    // A recovery probe failed: stay tripped and start the next skip window
    // immediately — no 3-strike grace. The trip was already surfaced at error
    // once; probes stay quiet.
    b.skipsSinceTrip = 0;
    logger.debug(`compaction breaker probe failed for op ${opId}; staying tripped`);
    return;
  }
  if (b.failures >= TRIP_THRESHOLD) {
    b.tripped = true;
    // Surface the error state honestly, ONCE, at trip time. Later skips log at
    // debug only — the state is readable via compactionBreakerState().
    // A null from summarizeOldMessages doesn't distinguish a summarize FAILURE
    // (provider error, timeout) from summarization being UNAVAILABLE (no provider
    // configured — classify-with-llm returns null fast when
    // resolveProviderContext() is null), so the message covers both.
    logger.error(
      `compaction circuit breaker tripped for op ${opId} after ${b.failures} consecutive ` +
      `summarize attempts returned nothing — summarization unavailable or failing ` +
      `(provider error, timeout, or no provider configured). Compaction now skips, ` +
      `re-probing every ${PROBE_INTERVAL}th call; context stays unsummarized ` +
      `meanwhile — over-window provider errors may follow.`,
    );
  }
}

/** A compaction that produced a summary: clear the streak, announce a recovery once. */
export function recordBreakerSuccess(opId: string, wasTripped: boolean): void {
  if (wasTripped) {
    logger.info(`compaction summarization recovered for op ${opId}; circuit breaker reset`);
  }
  breakers.delete(opId);
}

/** Readonly view of an op's breaker state, for telemetry/doctor. */
export function compactionBreakerState(
  opId: string,
): Readonly<{ failures: number; tripped: boolean; skipsSinceTrip: number }> | undefined {
  const b = breakers.get(opId);
  return b
    ? { failures: b.failures, tripped: b.tripped, skipsSinceTrip: b.skipsSinceTrip }
    : undefined;
}

// ─── Forced compaction (overflow recovery) ───────────────────────────────────
// When the PROVIDER rejects a call as over-window (context_overflow /
// payload-too-large), the threshold estimate demonstrably undershot — the next
// build-input must compact regardless of what the estimate says. The overflow
// recovery (adapter-throw-recovery.ts) sets this marker; compactHistory
// consumes it once: threshold check bypassed, aggressive keep, and the breaker
// skip is overridden (the provider error IS the probe signal).
const forcedOps = new Set<string>();

export function forceCompactNext(opId: string): void {
  forcedOps.add(opId);
}

/** Consume the marker (once) for this attempt. */
export function consumeForcedCompaction(opId: string | undefined): boolean {
  return opId ? forcedOps.delete(opId) : false;
}
