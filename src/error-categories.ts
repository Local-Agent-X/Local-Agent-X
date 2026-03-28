export type ErrorCategory =
  | "network"
  | "auth"
  | "model"
  | "tool"
  | "timeout"
  | "rateLimit"
  | "unknown";

interface CategorizedError {
  category: ErrorCategory;
  original: unknown;
  message: string;
}

const PATTERNS: Array<{ category: ErrorCategory; tests: Array<(msg: string, code?: number) => boolean> }> = [
  {
    category: "rateLimit",
    tests: [
      (msg) => /rate.?limit|too many requests|429|throttl/i.test(msg),
      (_msg, code) => code === 429,
    ],
  },
  {
    category: "auth",
    tests: [
      (msg) => /unauthorized|forbidden|auth|401|403|invalid.?key|token.?expired|permission.?denied/i.test(msg),
      (_msg, code) => code === 401 || code === 403,
    ],
  },
  {
    category: "timeout",
    tests: [
      (msg) => /timeout|timed.?out|ETIMEDOUT|ESOCKETTIMEDOUT|deadline.?exceeded/i.test(msg),
      (_msg, code) => code === 408 || code === 504,
    ],
  },
  {
    category: "network",
    tests: [
      (msg) => /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket|fetch.?failed|DNS/i.test(msg),
      (_msg, code) => code === 502 || code === 503,
    ],
  },
  {
    category: "model",
    tests: [
      (msg) => /model|context.?length|token|overloaded|capacity|content.?filter/i.test(msg),
    ],
  },
  {
    category: "tool",
    tests: [
      (msg) => /tool|function.?call|invalid.?argument|schema|parameter/i.test(msg),
    ],
  },
];

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
  }
  return String(error);
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

export function categorizeError(error: unknown): CategorizedError {
  const message = extractMessage(error);
  const code = extractStatusCode(error);

  for (const pattern of PATTERNS) {
    for (const test of pattern.tests) {
      if (test(message, code)) {
        return { category: pattern.category, original: error, message };
      }
    }
  }

  return { category: "unknown", original: error, message };
}

export function getErrorSummary(errors: unknown[]): Record<ErrorCategory, number> {
  const summary: Record<ErrorCategory, number> = {
    network: 0,
    auth: 0,
    model: 0,
    tool: 0,
    timeout: 0,
    rateLimit: 0,
    unknown: 0,
  };

  for (const err of errors) {
    const { category } = categorizeError(err);
    summary[category]++;
  }

  return summary;
}
