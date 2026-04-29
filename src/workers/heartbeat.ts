/**
 * Heartbeat protocol + worker watchdog.
 *
 * Per spec §4: every worker sends a heartbeat (pong reply to a ping)
 * every HEARTBEAT_INTERVAL_MS. The supervisor's watchdog kills + recycles
 * workers that go silent past HEARTBEAT_DEAD_MS, and also recycles
 * workers showing sustained heap pressure.
 *
 * Recovery (per spec §5): when a worker dies, the supervisor uses the
 * op's checkpoint.json to decide whether to retry. Bounded retries
 * (per spec §18) prevent "doesn't give up" from becoming "burns time."
 */

import { sendIpc } from "./ipc.js";
import { ipcEnvelope, type Op } from "./types.js";
import type { ChildProcess } from "node:child_process";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.heartbeat");

// ── Tunables ───────────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_SUSPECT_MS = 30_000;
export const HEARTBEAT_DEAD_MS = 60_000;
export const HEAP_PRESSURE_RATIO = 0.85;
export const HEAP_PRESSURE_SUSTAINED_TICKS = 3; // need this many ticks above threshold

// ── Per-worker watchdog state ──────────────────────────────────────────────

export interface HeartbeatState {
  workerId: string;
  lastHeartbeatTs: number;
  lastHeapMb: number;
  workerHeapLimitMb: number;
  consecutivePressureTicks: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
}

export function createHeartbeatState(workerId: string, workerHeapLimitMb = 2048): HeartbeatState {
  return {
    workerId,
    lastHeartbeatTs: Date.now(),
    lastHeapMb: 0,
    workerHeapLimitMb,
    consecutivePressureTicks: 0,
    pingTimer: null,
    watchdogTimer: null,
  };
}

export interface HeartbeatCallbacks {
  /** Called when worker is suspected dead (no heartbeat for HEARTBEAT_SUSPECT_MS). */
  onSuspect?: (workerId: string, silentForMs: number) => void;
  /** Called when worker is confirmed dead and should be recycled. */
  onDead: (workerId: string, silentForMs: number) => void;
  /** Called when worker is showing sustained heap pressure (recycle after current op). */
  onHeapPressure: (workerId: string, heapMb: number, limitMb: number) => void;
}

/**
 * Start sending pings + watching for missed pongs. Returns a stop function.
 */
export function startHeartbeat(
  proc: ChildProcess,
  state: HeartbeatState,
  callbacks: HeartbeatCallbacks,
): () => void {
  // Outbound: send a ping every HEARTBEAT_INTERVAL_MS
  state.pingTimer = setInterval(() => {
    if (!proc.stdin || proc.exitCode !== null) return;
    try {
      sendIpc(proc.stdin, ipcEnvelope("ping", { fromTs: new Date().toISOString() }));
    } catch (e) {
      logger.warn(`[heartbeat] ping send failed for ${state.workerId}: ${(e as Error).message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Inbound watchdog: check whether the worker is responding
  state.watchdogTimer = setInterval(() => {
    if (proc.exitCode !== null) return;
    const silentForMs = Date.now() - state.lastHeartbeatTs;
    if (silentForMs >= HEARTBEAT_DEAD_MS) {
      callbacks.onDead(state.workerId, silentForMs);
      stopHeartbeat(state);
      return;
    }
    if (silentForMs >= HEARTBEAT_SUSPECT_MS) {
      callbacks.onSuspect?.(state.workerId, silentForMs);
    }
    // Heap pressure check (separate from liveness)
    const ratio = state.lastHeapMb / state.workerHeapLimitMb;
    if (ratio > HEAP_PRESSURE_RATIO) {
      state.consecutivePressureTicks++;
      if (state.consecutivePressureTicks >= HEAP_PRESSURE_SUSTAINED_TICKS) {
        callbacks.onHeapPressure(state.workerId, state.lastHeapMb, state.workerHeapLimitMb);
        state.consecutivePressureTicks = 0;
      }
    } else {
      state.consecutivePressureTicks = 0;
    }
  }, HEARTBEAT_INTERVAL_MS);

  return () => stopHeartbeat(state);
}

export function stopHeartbeat(state: HeartbeatState): void {
  if (state.pingTimer) clearInterval(state.pingTimer);
  if (state.watchdogTimer) clearInterval(state.watchdogTimer);
  state.pingTimer = null;
  state.watchdogTimer = null;
}

/** Call when a 'pong' arrives from the worker. Updates state. */
export function recordPong(state: HeartbeatState, heapMb: number): void {
  state.lastHeartbeatTs = Date.now();
  state.lastHeapMb = heapMb;
}

// ── Recovery decision ─────────────────────────────────────────────────────

export interface RecoveryDecision {
  shouldRetry: boolean;
  reason: string;
  nextDelayMs: number;
}

/**
 * Per spec §18 + §20: decide whether to retry a failed op.
 *
 * Caps on retries come from op.retryPolicy. After cap, op is permanent-fail.
 * Side-effecting ops (one that's executed a committing tool call already)
 * cannot be safely retried — surfaced via `committingCallsAlreadyMade`.
 */
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

// ── Default policy registry (per spec §21.4) ──────────────────────────────

import type { OpRetryPolicy } from "./types.js";

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

// ── Circuit breaker per op-type ───────────────────────────────────────────

interface FailureBucket { failures: number[]; }
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;
const failureHistory = new Map<string, FailureBucket>();

/** Record an op-type failure. Returns true if the type's circuit is now open. */
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
