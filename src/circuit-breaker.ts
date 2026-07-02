/**
 * Per-(session, tool, call-signature) circuit breaker.
 *
 * Stops a specific CALL from being repeated after it fails N times in a row
 * in the same session. Prevents infinite-loop death spirals where an agent
 * keeps re-calling the same broken tool with the same args.
 *
 * Keyed by args signature on purpose: the old per-tool key locked out the
 * WHOLE tool for the session — four reads of one wrong path and the worker
 * lost `read` entirely for the cooldown, turning a recoverable flail into a
 * guaranteed dead run (live failure 2026-07-02). Exploration with varied
 * args is normal agent behavior; repeating the identical failing call is
 * the pathology. Callers that don't pass a signature share one per-tool
 * bucket (legacy semantics).
 *
 * State machine:
 *   closed   → normal, calls flow through. Failures increment counter.
 *   open     → calls are refused with a clear error. After cooldown, → half_open.
 *   half_open → next call is allowed; success closes, failure re-opens.
 *
 * Success deletes the entry — the map only ever holds failing signatures.
 */

import { createHash } from "node:crypto";
import { createLogger } from "./logger.js";
import { USER_HINTS } from "./types.js";
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS } from "./resilience-policy.js";
const logger = createLogger("circuit-breaker");

type BreakerState = "closed" | "open" | "half_open";

interface BreakerEntry {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  totalTrips: number;
  lastFailureAt: number;
}

const breakers = new Map<string, BreakerEntry>();
const MAX_ENTRIES = 1000;
let failureThreshold = CIRCUIT_FAILURE_THRESHOLD;
let cooldownMs = CIRCUIT_COOLDOWN_MS;

/** Stable signature for a tool call's arguments. Raw model-emitted args
 *  (string or object) — capped before hashing so huge payloads stay cheap. */
export function circuitArgsSig(rawArgs: unknown): string {
  if (rawArgs === undefined || rawArgs === null) return "";
  const s = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
  return s.slice(0, 4000);
}

function key(sessionId: string | undefined, toolName: string, argsSig?: string): string {
  const sig = argsSig ? createHash("sha1").update(argsSig).digest("hex").slice(0, 12) : "-";
  return `${sessionId || "default"}::${toolName}::${sig}`;
}

function getOrCreate(k: string): BreakerEntry {
  let entry = breakers.get(k);
  if (!entry) {
    entry = { state: "closed", consecutiveFailures: 0, openedAt: 0, totalTrips: 0, lastFailureAt: 0 };
    breakers.set(k, entry);
  }
  return entry;
}

/** Bound the map: entries whose story is over (long-cold failures) go first. */
function sweep(): void {
  if (breakers.size <= MAX_ENTRIES) return;
  const cutoff = Date.now() - 10 * cooldownMs;
  for (const [k, e] of breakers.entries()) {
    if (e.lastFailureAt < cutoff) breakers.delete(k);
  }
}

export interface CircuitDecision {
  allowed: boolean;
  state: BreakerState;
  reason?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  userHint?: string;
  consecutiveFailures: number;
}

/** Check whether a tool call may proceed. Call BEFORE executing the tool. */
export function checkCircuit(sessionId: string | undefined, toolName: string, argsSig?: string): CircuitDecision {
  const k = key(sessionId, toolName, argsSig);
  const entry = breakers.get(k);
  if (!entry) return { allowed: true, state: "closed", consecutiveFailures: 0 };

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
      reason: `Circuit OPEN for this exact ${toolName} call: ${entry.consecutiveFailures} consecutive failures with the same arguments. Change the arguments (different path/command) or wait ${remainingS}s — repeating the identical call will not work.`,
      userHint: USER_HINTS.retryExhausted,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  return { allowed: true, state: entry.state, consecutiveFailures: entry.consecutiveFailures };
}

/** Record a successful tool execution. Closes (removes) the breaker entry. */
export function recordCircuitSuccess(sessionId: string | undefined, toolName: string, argsSig?: string): void {
  breakers.delete(key(sessionId, toolName, argsSig));
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
  argsSig?: string,
): void {
  sweep();
  const entry = getOrCreate(key(sessionId, toolName, argsSig));
  entry.consecutiveFailures += 1;
  entry.lastFailureAt = Date.now();

  // Log EVERY failure with the error so we can see the ramp-up, not just
  // the trip. Capped to 200 chars to keep log lines digestible.
  const preview = (errorPreview || "(no error message captured)").slice(0, 200).replace(/\s+/g, " ");
  logger.warn(`[circuit-breaker] FAIL ${toolName} (session=${sessionId || "default"}) #${entry.consecutiveFailures}: ${preview}`);

  if (entry.state === "half_open") {
    // Half-open failure → re-open immediately. Logged so the failure ramp is
    // visible: without this, a cooldown-expired retry that fails again shows up
    // as a bare "FAIL #N" with no matching OPEN line, making it look like the
    // breaker waved the call through (the Grok #5 edit, 2026-06-09).
    entry.state = "open";
    entry.openedAt = Date.now();
    entry.totalTrips += 1;
    logger.warn(`[circuit-breaker] RE-OPEN ${toolName} (session=${sessionId || "default"}) after half-open retry failed (#${entry.consecutiveFailures})`);
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

/** Reset every breaker for a (session, tool) pair — all call signatures. */
export function resetCircuit(sessionId: string | undefined, toolName: string): void {
  const prefix = `${sessionId || "default"}::${toolName}::`;
  for (const k of breakers.keys()) {
    if (k.startsWith(prefix)) breakers.delete(k);
  }
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
