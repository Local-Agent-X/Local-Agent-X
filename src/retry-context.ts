/**
 * RetryContext — shared retry budget + correlationId for a single request.
 *
 * History: docs/retry-strategy-canonical.md was written when six retry
 * layers (L1-L6) could stack on one chat turn. After P4.C6 + bc91139 +
 * P5.C4 only L1 (`withRetry` in src/auto-retry.ts, called by tool-executor
 * for transient-network tools) remains. The shared-budget machinery
 * matters only when a second layer reappears, but the correlationId is
 * useful today: it stitches retry log lines for one turn together across
 * what telemetry would otherwise see as unrelated events.
 *
 * Future layers that would plug in here if resurrected:
 *   - Per-loop stream-error retries (L2/L3/L4) — were in run-anthropic /
 *     run-standard / agent-codex; deleted P4.C6.
 *   - Provider cascade (L5) — was in routes/chat.ts; deleted bc91139.
 *   - Warm-pool subprocess retry (L6) — never existed as a retry loop;
 *     warm-pool uses a wake-queue, not retries.
 */
import { randomUUID } from "node:crypto";

export interface RetryContext {
  /** Stable per-request id. Mirror into every retry log line so logs
   *  across layers/processes can be stitched. */
  correlationId: string;
  /** Budget shared across the request. `attemptsUsed` is the only field
   *  read today; `maxAttempts` / `deadlineMs` are reserved for when a
   *  second retry layer (re-)appears and the two need to cooperate. */
  budget: { maxAttempts: number; deadlineMs: number; attemptsUsed: number };
  /** Hook for telemetry / tests to observe retry attempts. */
  onAttempt?: (layer: string, attempt: number, err?: Error) => void;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_DEADLINE_MS = 90_000;

export function createRetryContext(
  opts?: Partial<RetryContext["budget"]> & { onAttempt?: RetryContext["onAttempt"] },
): RetryContext {
  return {
    correlationId: randomUUID(),
    budget: {
      maxAttempts: opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      deadlineMs: opts?.deadlineMs ?? Date.now() + DEFAULT_DEADLINE_MS,
      attemptsUsed: opts?.attemptsUsed ?? 0,
    },
    onAttempt: opts?.onAttempt,
  };
}

// ── Per-session attachment ──
// The tool-executor doesn't take a RetryContext parameter (would require
// threading through executeToolCalls → executeSingleTool → withRetry). The
// chat-turn entry attaches the context by sessionId; tool-executor reads
// it at the withRetry call site. Mirrors the session-policy.ts pattern.
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
