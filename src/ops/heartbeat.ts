/**
 * Retry policy + circuit breaker for ops.
 *
 * Per spec §18 + §20: bounded retries with backoff. Per spec §21.4:
 * per-op-type circuit breaker fires when a type fails too often inside a
 * rolling window.
 *
 * Worker-process heartbeats lived here before the canonical-loop migration
 * retired the fork pool; the recovery + retry policy is the part that
 * survived (canonical runners and op_submit_async still consult it).
 */
import type { Op, OpRetryPolicy } from "./types.js";

export interface RecoveryDecision {
  shouldRetry: boolean;
  reason: string;
  nextDelayMs: number;
}

export function decideRecovery(
  op: Op,
  failureContext: { committingCallsAlreadyMade: boolean; reason: string },
): RecoveryDecision {
  const attempts = op.attemptCount ?? 0;
  const max = op.retryPolicy.maxRecoveryAttempts;

  if (attempts >= max) {
    return { shouldRetry: false, reason: `attempts ${attempts}/${max} exhausted`, nextDelayMs: 0 };
  }
  if (failureContext.committingCallsAlreadyMade) {
    return {
      shouldRetry: false,
      reason: "side-effecting tool already executed; retry could double-mutate",
      nextDelayMs: 0,
    };
  }
  const backoffArr = op.retryPolicy.backoffMs;
  const nextDelayMs = backoffArr[Math.min(attempts, backoffArr.length - 1)] ?? 5_000;
  return { shouldRetry: true, reason: `retry ${attempts + 1}/${max} (${failureContext.reason})`, nextDelayMs };
}

const DEFAULT_RETRY_POLICY: OpRetryPolicy = {
  maxRecoveryAttempts: 3,
  backoffMs: [5_000, 30_000, 120_000],
};

const RETRY_POLICIES: Record<string, OpRetryPolicy> = {
  "send_email":           { maxRecoveryAttempts: 1, backoffMs: [10_000] },
  "research_query":       { maxRecoveryAttempts: 5, backoffMs: [5_000, 30_000, 60_000, 120_000, 300_000] },
  "autopilot_round":      { maxRecoveryAttempts: 2, backoffMs: [30_000, 120_000] },
  "build_app":            { maxRecoveryAttempts: 3, backoffMs: [30_000, 60_000, 180_000] },
  "memory_consolidation": { maxRecoveryAttempts: 5, backoffMs: [60_000, 300_000, 600_000, 1_800_000, 3_600_000] },
  "self_edit":            { maxRecoveryAttempts: 2, backoffMs: [10_000, 60_000] },
  "smoke-test":           { maxRecoveryAttempts: 1, backoffMs: [5_000] },
};

export function getRetryPolicy(opType: string): OpRetryPolicy {
  return RETRY_POLICIES[opType] ?? DEFAULT_RETRY_POLICY;
}

interface FailureBucket { failures: number[]; }
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;
const failureHistory = new Map<string, FailureBucket>();

export function recordFailure(opType: string): boolean {
  const now = Date.now();
  let bucket = failureHistory.get(opType);
  if (!bucket) { bucket = { failures: [] }; failureHistory.set(opType, bucket); }
  bucket.failures.push(now);
  bucket.failures = bucket.failures.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
  return bucket.failures.length >= CIRCUIT_BREAKER_THRESHOLD;
}

export function isCircuitOpen(opType: string): boolean {
  const bucket = failureHistory.get(opType);
  if (!bucket) return false;
  const now = Date.now();
  const recent = bucket.failures.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);
  return recent.length >= CIRCUIT_BREAKER_THRESHOLD;
}

export function resetCircuit(opType: string): void {
  failureHistory.delete(opType);
}
