// ResiliencePolicy — the single seam for "is this error retryable, and how
// hard should we back off?" Owns error classification (including context
// overflow, which the turn loop answers with compaction), retryability (error
// category + explicit tool effect eligibility), the backoff curve, and the circuit
// thresholds. Executors stay thin: auto-retry.ts runs the loop, circuit-
// breaker.ts runs the state machine — both read their policy from here.

import type { ToolDefinition, ToolEffect, ToolResult } from "./types.js";

export type ErrorCategory =
  | "network"
  | "auth"
  | "model"
  | "tool"
  | "timeout"
  | "rateLimit"
  | "overload"
  | "contentFilter"
  | "contextOverflow"
  | "unknown";

// ── Circuit-breaker thresholds (the state machine in circuit-breaker.ts
//    reads these; configureCircuitBreaker can still override at runtime). ──
export const CIRCUIT_FAILURE_THRESHOLD = 4;
export const CIRCUIT_COOLDOWN_MS = 30_000;

const UNKNOWN_EFFECT: ToolEffect = Object.freeze({ class: "non-idempotent" });

// Categories worth retrying: the failure is environmental, not the caller's
// fault. auth/model/tool/contentFilter won't improve on a retry.
const RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  "network",
  "timeout",
  "rateLimit",
  "overload",
]);

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
  }
  return String(error ?? "");
}

function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.code === "number") return e.code;
  }
  return undefined;
}

/**
 * One category's signals: the status codes that mean it, and the phrases a
 * message carries when no code came with it. Phrases are word-bounded and
 * qualified: the message is often a TOOL's text — a file path, a line number,
 * the contents of something the agent read — so "src/network/config.ts" is not
 * a network error and "line 4291" is not a 429 (runtime-coupling audit
 * 2026-10-15, #15). A status code is judged first, across every category,
 * before any wording.
 */
interface CategorySignals { category: ErrorCategory; codes?: (code: number) => boolean; phrases: RegExp[] }

const SIGNALS: CategorySignals[] = [
  {
    category: "rateLimit",
    codes: (code) => code === 429,
    phrases: [/\brate.?limit(?:s|ed|ing)?\b|\brate_limit\b|\btoo many requests\b|\bthrottl(?:ed|ing|e)\b|\bquota\b|\binsufficient_quota\b|\b429\b/i],
  },
  {
    category: "auth",
    codes: (code) => code === 401 || code === 403,
    phrases: [
      /\bunauthorized\b|\bforbidden\b|\binvalid.?api.?key\b|\binvalid_api_key\b|\btoken.?expired\b|\bexpired_token\b|\bpermission.?denied\b|\b401\b|\b403\b/i,
      /\bauthentication\b[^.\n]{0,40}\bfail/i,
    ],
  },
  {
    category: "contentFilter",
    phrases: [/\bcontent_filter\b|\bcontent.?filter\b|\bcontent moderation\b|\bcontent policy\b|\bsafety filter\b|\bmoderation loop\b/i],
  },
  {
    category: "timeout",
    codes: (code) => code === 408 || code === 504,
    phrases: [/\btime[d]?.?out\b|\betimedout\b|\besockettimedout\b|\bdeadline.?exceeded\b/i],
  },
  {
    category: "network",
    phrases: [
      /\beconnrefused\b|\beconnreset\b|\benotfound\b|\beai_again\b|\bgetaddrinfo\b|\bsocket hang up\b|\bfetch failed\b|\bnetworkerror\b/i,
      /\bnetwork (?:error|failure|unreachable|is unreachable|request failed|connection)\b|\bdns (?:lookup|resolution|error|failure)\b/i,
    ],
  },
  {
    category: "overload",
    codes: (code) => code >= 500 && code < 600,
    phrases: [/\boverloaded?\b|\bservice unavailable\b|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b|\bbad gateway\b|\bgateway time/i, /\binternal server error\b|\b(?:at|over) capacity\b/i],
  },
  {
    // The request is bigger than the model's window. Providers ship it as HTTP
    // 400 (Anthropic "prompt is too long: X tokens > Y maximum", OpenAI "This
    // model's maximum context length is ..."), so the wording decides, ahead of
    // "model". Not retryable as sent: the turn loop compacts, then resends.
    category: "contextOverflow",
    codes: (code) => code === 413,
    phrases: [/\b(payload too large|request entity too large|max(_|imum)? tokens?|content too long|prompt is too long|maximum context length|context (length|window)\b.{0,60}\bexceed|exceeds?\b.{0,60}\bcontext (length|window)|input is too long)\b/i],
  },
  {
    category: "model",
    phrases: [/\bcontext.?length\b|\bmax.?tokens\b|\btoken limit\b|\bmodel\b/i],
  },
  {
    category: "tool",
    phrases: [/\btool\b|\bfunction.?call\b|\binvalid.?argument\b|\bschema\b|\bparameter\b/i],
  },
];

/** Map any thrown value to a single ErrorCategory: by status code first, then
 *  by wording in category order. */
export function classify(error: unknown): ErrorCategory {
  const message = extractMessage(error);
  const code = extractStatusCode(error);
  if (code !== undefined) {
    for (const { category, codes } of SIGNALS) if (codes?.(code)) return category;
  }
  for (const { category, phrases } of SIGNALS) {
    if (phrases.some((re) => re.test(message))) return category;
  }
  return "unknown";
}

/** Resolve canonical effect metadata. Missing metadata fails closed. */
export function resolveToolEffect(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown> = {},
): ToolEffect {
  if (!tool?.effect) return UNKNOWN_EFFECT;
  return typeof tool.effect === "function" ? tool.effect(args) : tool.effect;
}

export function isRetryableEffect(effect: ToolEffect): boolean {
  if (effect.class === "read-only" || effect.class === "idempotent-mutation") return true;
  return effect.class === "keyed-mutation" &&
    typeof effect.operationKey === "string" && effect.operationKey.trim().length > 0;
}

/** Whether replaying this exact tool call is safe after an ambiguous failure. */
export function isRetryableTool(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown> = {},
): boolean {
  return isRetryableEffect(resolveToolEffect(tool, args));
}

/**
 * Should this error be retried? Combines per-tool eligibility (when a
 * tool is supplied) with the error's category. Without a tool the
 * decision is category-only (provider/transport callers).
 */
export function isRetryable(
  error: unknown,
  opts?: { effect?: ToolEffect; tool?: ToolDefinition; args?: Record<string, unknown>; attempt?: number },
): boolean {
  if (opts?.effect && !isRetryableEffect(opts.effect)) return false;
  if (opts?.tool && !isRetryableTool(opts.tool, opts.args)) return false;
  if (error instanceof RetryableToolResultError) return true;
  return RETRYABLE_CATEGORIES.has(classify(error));
}

export class RetryableToolResultError extends Error {
  readonly result: ToolResult;

  constructor(result: ToolResult) {
    super(typeof result.content === "string" ? result.content : "Transient tool result");
    this.name = "RetryableToolResultError";
    this.result = result;
  }
}

/** Convert only recognized transient error results into the retry loop's signal. */
export function retrySignalForToolResult(
  result: ToolResult,
  effect: ToolEffect,
): RetryableToolResultError | null {
  if (!result.isError || !isRetryableEffect(effect)) return null;
  const status = typeof result.metadata?.status === "number" ? result.metadata.status : undefined;
  const message = typeof result.content === "string" ? result.content : String(result.content ?? "");
  if (!RETRYABLE_CATEGORIES.has(classify({ message, status }))) return null;
  return new RetryableToolResultError(result);
}

/**
 * Backoff before the next attempt. `attempt` is 1-based (the attempt that
 * just failed). Exponential base-1000 with ±500ms jitter; rate-limit and
 * overload errors get a higher ceiling since the server is asking us to wait.
 */
export function backoffMs(attempt: number, category?: ErrorCategory): number {
  const exp = 1000 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * 500;
  const cap = category === "rateLimit" || category === "overload" ? 16_000 : 8_000;
  return Math.min(exp + jitter, cap);
}
