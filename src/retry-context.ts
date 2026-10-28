/**
 * RetryContext — the correlationId that stitches one chat turn's tool-retry
 * log lines (`withRetry` in src/auto-retry.ts, called by
 * tool-execution/tool-runner.ts) together across what telemetry would
 * otherwise see as unrelated events.
 *
 * Not a retry budget. Each retry layer bounds itself and owns a different
 * failure: a tool call's transient error (`withRetry`, its own maxRetries);
 * one provider request (canonical-loop/adapters/transport-retry.ts); an op
 * whose turn failed before doing anything (the worker's re-queue,
 * canonical-loop/worker-adapter-retry.ts). A shared attempt budget once lived
 * here and gated `withRetry`; it killed slow-start tools before their first
 * attempt when earlier work had spent it, so the gate went, and the fields
 * nothing read went after it.
 */
import { randomUUID } from "node:crypto";

export interface RetryContext {
  /** Stable per-request id. Mirror into every retry log line so logs
   *  across layers/processes can be stitched. */
  correlationId: string;
}

export function createRetryContext(): RetryContext {
  return { correlationId: randomUUID() };
}

// ── Per-session attachment ──
// The tool runner doesn't take a RetryContext parameter (would require
// threading through executeToolCalls → the dispatch phases → withRetry). The
// chat-turn entry attaches the context by sessionId; tool-runner.ts reads it
// at the withRetry call site. Mirrors the session-policy.ts pattern.
const BY_SESSION = new Map<string, RetryContext>();

export function attachRetryContext(sessionId: string, ctx: RetryContext): void {
  BY_SESSION.set(sessionId, ctx);
}

export function getRetryContext(sessionId: string | undefined): RetryContext | undefined {
  if (!sessionId) return undefined;
  return BY_SESSION.get(sessionId);
}

export function detachRetryContext(sessionId: string): void {
  BY_SESSION.delete(sessionId);
}
