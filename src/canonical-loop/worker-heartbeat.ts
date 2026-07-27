/**
 * Worker heartbeat — keeps the op lease fresh while a turn runs, and decides
 * when a heartbeat failure actually means the lease is gone.
 *
 * Split from worker.ts (at the file-size ceiling) so the policy is
 * independently testable:
 *   - `claim_lost` / `unknown_op` are fatal immediately: the lease was stolen
 *     by recovery (or the op row vanished) and the in-flight turn must abort
 *     before it commits over the replacement's work.
 *   - `lock_unavailable` / `persistence_failed` are TRANSIENT: the op lock was
 *     briefly held by a concurrent commit, or one refresh write failed. A
 *     single 10s tick's contention must not abort a healthy multi-minute turn
 *     (observed live 2026-07-24) — only enough consecutive failures to
 *     plausibly lose the lease are fatal.
 *   - A late tick is the starvation signal: when the event loop stalls past
 *     the interval, the lease can expire with nothing wrong with the op
 *     itself. Logged loudly so the condition is diagnosable from server.log.
 */
import { heartbeatLease, getLeaseConfig, type LeaseClaim } from "./lease.js";

/** Consecutive transient failures tolerated before the claim is treated as
 *  lost — 3 ticks is a full default lease duration of continuous contention. */
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 3;

// Live timers keyed by workerId. Tests use `_pauseHeartbeat` to simulate a
// crashed worker (heartbeat stops, lease expires naturally).
const HEARTBEATS = new Map<string, NodeJS.Timeout>();

/**
 * Test-only: stop the heartbeat for a worker without releasing its lease.
 * Simulates a process death — the lease will expire naturally and recovery
 * can pick up the op. NOT exported as part of the canonical-loop API; the
 * leading underscore signals "internal".
 */
export function _pauseHeartbeat(workerId: string): boolean {
  const t = HEARTBEATS.get(workerId);
  if (!t) return false;
  clearInterval(t);
  HEARTBEATS.delete(workerId);
  return true;
}

/**
 * Start the periodic lease refresh for a leased op. `onFatal` fires at most
 * once, after the heartbeat has been stopped, when the claim is genuinely
 * lost (stolen lease, vanished op, or transient failures past the tolerance).
 * `beatFn` is an injection seam for the policy tests; production callers
 * never pass it.
 */
export function startHeartbeat(
  opId: string,
  workerId: string,
  claim: LeaseClaim,
  onFatal: () => void,
  beatFn: typeof heartbeatLease = heartbeatLease,
): void {
  const cfg = getLeaseConfig();
  let transientFailures = 0;
  let lastTickAt = Date.now();
  const hb = setInterval(() => {
    const now = Date.now();
    const lateBy = now - lastTickAt - cfg.heartbeatIntervalMs;
    lastTickAt = now;
    if (lateBy > cfg.leaseDurationMs - cfg.heartbeatIntervalMs) {
      console.error(
        `[lease] heartbeat late by ${lateBy}ms (op=${opId}) — event-loop starvation past the lease duration; the lease has likely expired`,
      );
    } else if (lateBy > cfg.heartbeatIntervalMs) {
      console.warn(`[lease] heartbeat late by ${lateBy}ms (op=${opId}) — event-loop starvation`);
    }

    const beat = beatFn(opId, claim);
    if (beat.ok) {
      transientFailures = 0;
      return;
    }
    const transient = beat.reason === "lock_unavailable" || beat.reason === "persistence_failed";
    if (transient && ++transientFailures < MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
      console.warn(
        `[lease] heartbeat transient failure ${transientFailures}/${MAX_CONSECUTIVE_TRANSIENT_FAILURES} (${beat.reason}) op=${opId} — retrying next tick`,
      );
      return;
    }
    stopHeartbeat(workerId);
    onFatal();
  }, cfg.heartbeatIntervalMs);
  HEARTBEATS.set(workerId, hb);
}

/** Idempotent: clear and forget the worker's timer (worker exit or fatal). */
export function stopHeartbeat(workerId: string): void {
  const t = HEARTBEATS.get(workerId);
  if (t) clearInterval(t);
  HEARTBEATS.delete(workerId);
}

/**
 * Does THIS process still have an armed heartbeat timer for the worker?
 *
 * This is direct evidence of life: the timer is armed between startHeartbeat
 * and stopHeartbeat, and every death path clears it — worker exit and fatal
 * both run stopHeartbeat, and the tick loop stops itself on a lost claim or
 * exhausted transient budget. So an armed timer with an EXPIRED lease means
 * the worker is starved (event-loop stall past the lease window), not dead.
 * Recovery consults this before treating lease expiry as proof of death; the
 * map cannot wedge a dead worker alive because it self-clears on every
 * failure path, so no staleness ceiling is needed here.
 */
export function hasArmedHeartbeat(workerId: string): boolean {
  return HEARTBEATS.has(workerId);
}
