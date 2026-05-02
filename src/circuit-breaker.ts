/**
 * Per-(session, tool) circuit breaker.
 *
 * Stops a specific tool from being called repeatedly after it fails N times
 * in a row in the same session. Prevents infinite-loop death spirals where
 * an agent keeps re-calling the same broken tool with the same args.
 *
 * State machine:
 *   closed   → normal, calls flow through. Failures increment counter.
 *   open     → calls are refused with a clear error. After cooldown, → half_open.
 *   half_open → next call is allowed; success closes, failure re-opens.
 *
 * Counter resets on any success. Successes in closed state are free.
 */

import { createLogger } from "./logger.js";
const logger = createLogger("circuit-breaker");

type BreakerState = "closed" | "open" | "half_open";

interface BreakerEntry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  totalTrips: number;
}

const DEFAULT_FAILURE_THRESHOLD = 4;
const DEFAULT_COOLDOWN_MS = 30_000;

const breakers = new Map<string, BreakerEntry>();
let failureThreshold = DEFAULT_FAILURE_THRESHOLD;
let cooldownMs = DEFAULT_COOLDOWN_MS;

function key(sessionId: string | undefined, toolName: string): string {
  return `${sessionId || "default"}::${toolName}`;
}

function getOrCreate(k: string): BreakerEntry {
  let entry = breakers.get(k);
  if (!entry) {
    entry = { state: "closed", consecutiveFailures: 0, openedAt: 0, totalTrips: 0 };
    breakers.set(k, entry);
  }
  return entry;
}

export interface CircuitDecision {
  allowed: boolean;
  state: BreakerState;
  reason?: string;
  consecutiveFailures: number;
}

/** Check whether a tool call may proceed. Call BEFORE executing the tool. */
export function checkCircuit(sessionId: string | undefined, toolName: string): CircuitDecision {
  const k = key(sessionId, toolName);
  const entry = getOrCreate(k);

  if (entry.state === "open") {
    const elapsed = Date.now() - entry.openedAt;
    if (elapsed >= cooldownMs) {
      entry.state = "half_open";
      return { allowed: true, state: "half_open", consecutiveFailures: entry.consecutiveFailures };
    }
    const remainingS = Math.ceil((cooldownMs - elapsed) / 1000);
    return {
      allowed: false,
      state: "open",
      reason: `Circuit OPEN for ${toolName}: ${entry.consecutiveFailures} consecutive failures. Try a different approach or wait ${remainingS}s. Calling the same tool with the same args will not work.`,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  return { allowed: true, state: entry.state, consecutiveFailures: entry.consecutiveFailures };
}

/** Record a successful tool execution. Closes the breaker. */
export function recordCircuitSuccess(sessionId: string | undefined, toolName: string): void {
  const entry = getOrCreate(key(sessionId, toolName));
  entry.state = "closed";
  entry.consecutiveFailures = 0;
}

/** Record a failed tool execution. Trips the breaker after threshold.
 *  `errorPreview` is the first ~200 chars of the tool result.content — logged
 *  on EVERY failure so debugging a circuit trip doesn't require guessing what
 *  the tool returned. (Pre-fix the breaker logged "OPEN after 4 failures"
 *  with no clue what those failures were — autopilot debugging hell.) */
export function recordCircuitFailure(
  sessionId: string | undefined,
  toolName: string,
  errorPreview?: string,
): void {
  const entry = getOrCreate(key(sessionId, toolName));
  entry.consecutiveFailures += 1;

  // Log EVERY failure with the error so we can see the ramp-up, not just
  // the trip. Capped to 200 chars to keep log lines digestible.
  const preview = (errorPreview || "(no error message captured)").slice(0, 200).replace(/\s+/g, " ");
  logger.warn(`[circuit-breaker] FAIL ${toolName} (session=${sessionId || "default"}) #${entry.consecutiveFailures}: ${preview}`);

  if (entry.state === "half_open") {
    // Half-open failure → re-open immediately
    entry.state = "open";
    entry.openedAt = Date.now();
    entry.totalTrips += 1;
    return;
  }

  if (entry.consecutiveFailures >= failureThreshold) {
    entry.state = "open";
    entry.openedAt = Date.now();
    entry.totalTrips += 1;
    logger.warn(`[circuit-breaker] OPEN ${toolName} (session=${sessionId || "default"}) after ${entry.consecutiveFailures} failures`);
  }
}

/** Force-reset all breakers (for tests or admin). */
export function resetAllCircuits(): void {
  breakers.clear();
}

/** Reset a specific (session, tool) breaker. */
export function resetCircuit(sessionId: string | undefined, toolName: string): void {
  breakers.delete(key(sessionId, toolName));
}

/** Snapshot of breakers that are currently open or half-open. */
export function getCircuitSnapshot(): Array<{ key: string; state: BreakerState; consecutiveFailures: number; totalTrips: number }> {
  const out: Array<{ key: string; state: BreakerState; consecutiveFailures: number; totalTrips: number }> = [];
  for (const [k, entry] of breakers.entries()) {
    if (entry.state !== "closed" || entry.totalTrips > 0) {
      out.push({ key: k, state: entry.state, consecutiveFailures: entry.consecutiveFailures, totalTrips: entry.totalTrips });
    }
  }
  return out;
}

/** Configure thresholds (call once at startup if defaults need adjusting). */
export function configureCircuitBreaker(opts: { failureThreshold?: number; cooldownMs?: number }): void {
  if (typeof opts.failureThreshold === "number" && opts.failureThreshold > 0) {
    failureThreshold = opts.failureThreshold;
  }
  if (typeof opts.cooldownMs === "number" && opts.cooldownMs >= 0) {
    cooldownMs = opts.cooldownMs;
  }
}
