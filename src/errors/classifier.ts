/**
 * Error classifier — single owner for "what kind of error / unexpected
 * result is this and how should we recover?"
 *
 * Replaces scattered inline string-matching with a centralized classifier
 * that the main retry loop consults for every API failure.
 *
 * Today this logic in LAX is scattered across:
 *   - src/agent-guards.ts (EMPTY_RESULT_RE for dead-end detection)
 *   - src/ops/worker-entry.ts (REFUSAL_PATTERNS for worker output)
 *   - src/providers/run-anthropic.ts (transient-error detection)
 *   - src/agent-loop-detectors.ts (various unresolved-error patterns)
 *
 * The classifier here is a SHELL with the most common patterns ported
 * from those files. Old call sites are updated to call classify() and
 * dispatch on the returned reason. Adding a new pattern = edit this file
 * (only). Tuning recovery strategy = edit this file (only).
 *
 * Start with the most-used patterns; expand the taxonomy as we hit
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
  /** Tool returned empty/null/zero results N times in a row. */
  EmptyResult = "empty_result",

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
const EMPTY_RESULT_RE = /^\s*(\(no output\)|\[\]|\{\}|null|none|No results?|0 results?|Nothing found|No matches|No files matched?|No relevant memor|Command failed)/i;

/** API error message hints by status code or substring. */
const STATUS_HINTS: Array<{ test: (msg: string, code?: number) => boolean; reason: FailoverReason; recovery: RecoveryAction; retryable: boolean }> = [
  { test: (m, c) => c === 401 || c === 403 || /\b(unauthorized|forbidden|authentication|invalid api key|expired token)\b/i.test(m), reason: FailoverReason.Auth, recovery: "rotate", retryable: true },
  { test: (_, c) => c === 402 || /\b(billing|payment|credit.*exhausted|quota.*exceeded)\b/i.test(_), reason: FailoverReason.Billing, recovery: "rotate", retryable: false },
  { test: (m, c) => c === 429 || /\b(rate.?limit|too many requests|quota.*throttl)/i.test(m), reason: FailoverReason.RateLimit, recovery: "retry", retryable: true },
  { test: (m, c) => c === 503 || c === 529 || /\b(overloaded|service unavailable|capacity)/i.test(m), reason: FailoverReason.Overloaded, recovery: "retry", retryable: true },
  { test: (m, c) => c === 500 || c === 502 || /\b(internal server error|bad gateway|upstream error)/i.test(m), reason: FailoverReason.ServerError, recovery: "retry", retryable: true },
  { test: (m) => /\b(timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up)\b/i.test(m), reason: FailoverReason.Timeout, recovery: "retry", retryable: true },
  // Ordered BEFORE the 400/FormatError hint: providers ship overflow as HTTP
  // 400 (Anthropic "prompt is too long: X tokens > Y maximum"; OpenAI "This
  // model's maximum context length is ..."), and message match must win over
  // the bare status code.
  { test: (m, c) => c === 413 || /\b(payload too large|request entity too large|max(_|imum)? tokens?|content too long|prompt is too long|maximum context length|context (length|window)\b.{0,60}\bexceed|exceeds?\b.{0,60}\bcontext (length|window)|input is too long)\b/i.test(m), reason: FailoverReason.ContextOverflow, recovery: "compress", retryable: true },
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

