// ResiliencePolicy — the single seam for "is this error retryable, and how
// hard should we back off?" Owns error classification, retryability (error
// category + per-tool eligibility), the backoff curve, and the circuit
// thresholds. Executors stay thin: auto-retry.ts runs the loop, circuit-
// breaker.ts runs the state machine — both read their policy from here.

export type ErrorCategory =
  | "network"
  | "auth"
  | "model"
  | "tool"
  | "timeout"
  | "rateLimit"
  | "overload"
  | "contentFilter"
  | "unknown";

// ── Circuit-breaker thresholds (the state machine in circuit-breaker.ts
//    reads these; configureCircuitBreaker can still override at runtime). ──
export const CIRCUIT_FAILURE_THRESHOLD = 4;
export const CIRCUIT_COOLDOWN_MS = 30_000;

// ── Per-tool retry eligibility ──
// Tools whose failures are usually transient (network, rate limit).
const RETRYABLE_TOOLS = new Set(["http_request", "web_fetch", "web_search", "browser"]);
// Tools whose failures are deterministic — retrying re-runs the same mutation.
const NEVER_RETRY = new Set(["bash", "write", "edit", "agent_spawn", "delegate"]);

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

type Test = (msg: string, code?: number) => boolean;

const PATTERNS: Array<{ category: ErrorCategory; tests: Test[] }> = [
  {
    category: "rateLimit",
    tests: [
      (msg) => /rate.?limit|rate_limit|too many requests|429|throttl|quota|insufficient_quota/i.test(msg),
      (_m, code) => code === 429,
    ],
  },
  {
    category: "auth",
    tests: [
      (msg) =>
        /unauthorized|forbidden|invalid.?api.?key|invalid_api_key|token.?expired|expired_token|permission.?denied|\b401\b|\b403\b/i.test(msg),
      (msg) => /authentication/i.test(msg) && /fail/i.test(msg),
      (_m, code) => code === 401 || code === 403,
    ],
  },
  {
    category: "contentFilter",
    tests: [
      (msg) => /content_filter|content.?filter|content moderation|content policy|safety filter|moderation loop/i.test(msg),
    ],
  },
  {
    category: "timeout",
    tests: [
      (msg) => /timeout|timed.?out|etimedout|esockettimedout|deadline.?exceeded/i.test(msg),
      (_m, code) => code === 408 || code === 504,
    ],
  },
  {
    category: "network",
    tests: [
      (msg) => /econnrefused|econnreset|enotfound|eai_again|socket hang up|network|fetch.?failed|\bdns\b/i.test(msg),
    ],
  },
  {
    category: "overload",
    tests: [
      (msg) => /overload|service unavailable|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b|gateway|internal server error|capacity/i.test(msg),
      (_m, code) => code !== undefined && code >= 500 && code < 600,
    ],
  },
  {
    category: "model",
    tests: [
      (msg) => /context.?length|max.?tokens|token limit|\bmodel\b/i.test(msg),
    ],
  },
  {
    category: "tool",
    tests: [
      (msg) => /\btool\b|function.?call|invalid.?argument|schema|parameter/i.test(msg),
    ],
  },
];

/** Map any thrown value to a single ErrorCategory. */
export function classify(error: unknown): ErrorCategory {
  const message = extractMessage(error);
  const code = extractStatusCode(error);
  for (const { category, tests } of PATTERNS) {
    for (const test of tests) {
      if (test(message, code)) return category;
    }
  }
  return "unknown";
}

/** Whether a tool is eligible for retry at all (network-ish, non-mutating). */
export function isRetryableTool(toolName: string): boolean {
  return RETRYABLE_TOOLS.has(toolName) && !NEVER_RETRY.has(toolName);
}

/**
 * Should this error be retried? Combines per-tool eligibility (when a
 * toolName is supplied) with the error's category. Without a toolName the
 * decision is category-only (provider/transport callers).
 */
export function isRetryable(error: unknown, opts?: { toolName?: string; attempt?: number }): boolean {
  if (opts?.toolName && !isRetryableTool(opts.toolName)) return false;
  return RETRYABLE_CATEGORIES.has(classify(error));
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
