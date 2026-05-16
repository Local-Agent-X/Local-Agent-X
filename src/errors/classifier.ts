/**
 * Error classifier — single owner for "what kind of error / unexpected
 * result is this and how should we recover?"
 *
 * Pattern stolen from /tmp/compare/upstream-agent-main/agent/error_classifier.py:
 *   "Replaces scattered inline string-matching with a centralized classifier
 *    that the main retry loop consults for every API failure."
 *
 * Today this logic in SAX is scattered across:
 *   - src/agent-guards.ts (EMPTY_RESULT_RE for dead-end detection)
 *   - src/ops/worker-entry.ts (REFUSAL_PATTERNS for worker output)
 *   - src/context-manager.ts (isContextOverflowError)
 *   - src/providers/run-anthropic.ts (transient-error detection)
 *   - src/agent-loop-detectors.ts (various unresolved-error patterns)
 *
 * The classifier here is a SHELL with the most common patterns ported
 * from those files. Old call sites are updated to call classify() and
 * dispatch on the returned reason. Adding a new pattern = edit this file
 * (only). Tuning recovery strategy = edit this file (only).
 *
 * upstream' original taxonomy is much richer (1000 LOC) — we steal the
 * shape and the most-used patterns now; expand the taxonomy as we hit
 * cases that need finer-grained recovery.
 */

// ── Error taxonomy ─────────────────────────────────────────────────────

/**
 * Why an API call or agent output failed — determines recovery strategy.
 * Single enum used everywhere; no provider-specific subtypes (the
 * provider field on ClassifiedError captures that detail).
 */
export enum FailoverReason {
  // ── API-side errors ──
  /** 401/403 transient — refresh credential and retry. */
  Auth = "auth",
  /** Auth failed even after refresh — abort. */
  AuthPermanent = "auth_permanent",
  /** 402 / billing / credit exhaustion — rotate credential immediately. */
  Billing = "billing",
  /** 429 / rate limit / quota throttling — backoff then retry. */
  RateLimit = "rate_limit",
  /** 503/529 — provider overloaded, exponential backoff. */
  Overloaded = "overloaded",
  /** 500/502 — internal server error, retry. */
  ServerError = "server_error",
  /** Timeout — rebuild client + retry. */
  Timeout = "timeout",

  // ── Context / payload ──
  /** Context too large for the model window — compress, then retry. */
  ContextOverflow = "context_overflow",
  /** 413 — payload too large, compress. */
  PayloadTooLarge = "payload_too_large",

  // ── Model / format ──
  /** 404 / invalid model — fallback to a different model. */
  ModelNotFound = "model_not_found",
  /** 400 bad request — abort or strip + retry. */
  FormatError = "format_error",

  // ── Agent output (not API errors — semantic failures) ──
  /** Agent ended without calling tools, output looks like "I can't do this". */
  AgentRefusal = "agent_refusal",
  /** Tool returned empty/null/zero results N times in a row. */
  EmptyResult = "empty_result",
  /** Worker exited with no WORK_DONE sentinel and no meaningful work. */
  NoProgressMade = "no_progress_made",

  // ── Catch-all ──
  /** Unclassifiable — retry with backoff or escalate. */
  Unknown = "unknown",
}

/** Suggested recovery action for the caller to dispatch on. */
export type RecoveryAction =
  | "retry"            // transient; try again, possibly with backoff
  | "rotate"           // credential is bad; switch creds
  | "fallback"         // this provider/model won't work; try alternative
  | "compress"         // input was too big; trim and retry
  | "abort";           // unrecoverable; surface to user

export interface ClassifiedError {
  reason: FailoverReason;
  recovery: RecoveryAction;
  retryable: boolean;
  /** Optional structured fields the caller may use. */
  statusCode?: number;
  provider?: string;
  message: string;
}

// ── Pattern definitions (consolidated from scattered call sites) ────────

/** Tool result that's effectively "no data" — used by agent-guards dead-end detector. */
const EMPTY_RESULT_RE = /^\s*(\(no output\)|\[\]|\{\}|null|none|No results?|0 results?|Nothing found|No matches|No relevant memor|Command failed)/i;

/** Worker output that signals refusal / "I can't do this" — used by worker classifier. */
const REFUSAL_PATTERNS = [
  /\bI (don't|do not) have (the |access to |any )?\w*\s*(file ?system|filesystem|standard)?\s*(tools?|access)/i,
  /\bI (can't|cannot|am unable to|am not able to|don't have a way to)\s+(audit|refactor|edit|read|modify|access|complete|do this)/i,
  /\bno (filesystem|tool|MCP|standard)\s+(access|tools?)\s+(available|exposed|enabled)/i,
  /\b(could|can|please) you (re-?run|provide|share|paste|enable)/i,
  /\bplease (re-?run|provide|share|paste|enable)\s+(this|the file|tools|file contents)/i,
  /\b(I'll|I will|I would) need\b/i,
  /\bI should\s+(read|check|look at|inspect|examine|review|edit|modify|update|run)/i,
  /\blet me know if you (want|'d like)|\blet me know if (you'd like )?I should\b/i,
  /\b(would you like|do you want) me to\b/i,
  /\bI (could|can) (read|check|look at|inspect|examine|edit|modify|update|run|do)\b.*\?\s*$/i,
];

/** API error message hints by status code or substring. */
const STATUS_HINTS: Array<{ test: (msg: string, code?: number) => boolean; reason: FailoverReason; recovery: RecoveryAction; retryable: boolean }> = [
  { test: (m, c) => c === 401 || c === 403 || /\b(unauthorized|forbidden|authentication|invalid api key|expired token)\b/i.test(m), reason: FailoverReason.Auth, recovery: "rotate", retryable: true },
  { test: (_, c) => c === 402 || /\b(billing|payment|credit.*exhausted|quota.*exceeded)\b/i.test(_), reason: FailoverReason.Billing, recovery: "rotate", retryable: false },
  { test: (m, c) => c === 429 || /\b(rate.?limit|too many requests|quota.*throttl)/i.test(m), reason: FailoverReason.RateLimit, recovery: "retry", retryable: true },
  { test: (m, c) => c === 503 || c === 529 || /\b(overloaded|service unavailable|capacity)/i.test(m), reason: FailoverReason.Overloaded, recovery: "retry", retryable: true },
  { test: (m, c) => c === 500 || c === 502 || /\b(internal server error|bad gateway|upstream error)/i.test(m), reason: FailoverReason.ServerError, recovery: "retry", retryable: true },
  { test: (m) => /\b(timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up)\b/i.test(m), reason: FailoverReason.Timeout, recovery: "retry", retryable: true },
  { test: (m, c) => c === 413 || /\b(payload too large|request entity too large|max(_|imum)? token|content too long)\b/i.test(m), reason: FailoverReason.ContextOverflow, recovery: "compress", retryable: true },
  { test: (m, c) => c === 404 || /\b(model not found|invalid model|unknown model)\b/i.test(m), reason: FailoverReason.ModelNotFound, recovery: "fallback", retryable: true },
  { test: (m, c) => c === 400 || /\b(bad request|invalid request|malformed)\b/i.test(m), reason: FailoverReason.FormatError, recovery: "abort", retryable: false },
];

// ── Public surface ─────────────────────────────────────────────────────

/**
 * Classify an arbitrary error or unexpected result. Caller dispatches on
 * .reason and .recovery to choose the next action.
 *
 * Inputs accepted:
 *   - Error / Error-shaped object (uses .message, .status, .statusCode)
 *   - String error message
 *   - { message, status, statusCode, provider } object
 */
export function classify(error: unknown, context?: { provider?: string }): ClassifiedError {
  let message = "";
  let statusCode: number | undefined;

  if (error instanceof Error) {
    message = error.message || "";
    const anyErr = error as Error & { status?: number; statusCode?: number };
    statusCode = anyErr.status ?? anyErr.statusCode;
  } else if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object") {
    const obj = error as { message?: string; status?: number; statusCode?: number };
    message = obj.message || JSON.stringify(error).slice(0, 500);
    statusCode = obj.status ?? obj.statusCode;
  } else {
    message = String(error);
  }

  for (const hint of STATUS_HINTS) {
    if (hint.test(message, statusCode)) {
      return {
        reason: hint.reason,
        recovery: hint.recovery,
        retryable: hint.retryable,
        statusCode,
        provider: context?.provider,
        message,
      };
    }
  }

  return {
    reason: FailoverReason.Unknown,
    recovery: "retry",
    retryable: true,
    statusCode,
    provider: context?.provider,
    message,
  };
}

/**
 * Detect whether a tool result text indicates "no useful data" — used by
 * dead-end loop detector. Single regex source so adding a new empty-result
 * pattern (e.g. a new tool that says "no rows" instead of "0 results")
 * means editing this file (only).
 */
export function isEmptyResultText(text: string): boolean {
  return EMPTY_RESULT_RE.test(text);
}

/**
 * Detect whether an agent's final text looks like a refusal — "I can't do
 * this", "please re-run", "I would need". Used by worker-entry's
 * classifyOpResult to mark a worker as failed even when stopReason is
 * "end_turn" (the agent ended cleanly but didn't actually do the work).
 *
 * Caller must combine with "no tool calls executed" — these patterns are
 * common in legitimate "I'll need X" messages where the agent then runs
 * tools. Only ENDED-turn-with-no-tool-calls + matches = real refusal.
 */
export function looksLikeAgentRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some(rx => rx.test(text));
}

/**
 * Convenience: classify an Anthropic context-overflow error specifically.
 * Anthropic's "input too long" errors come back with various message
 * shapes; the classifier handles the common ones, this is the named
 * helper that callers should use for that specific check.
 */
export function isContextOverflowError(err: unknown): boolean {
  return classify(err).reason === FailoverReason.ContextOverflow;
}
