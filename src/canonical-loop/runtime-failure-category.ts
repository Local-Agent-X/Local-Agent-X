/**
 * Which kind of runtime failure an op hit, in the vocabulary runtime failover
 * (runtime-failover.ts) decides by: whether to try another target, and whether
 * the failure says something about the target worth routing on.
 */
import { classify, type ErrorCategory } from "../resilience-policy.js";

/** A failure the op's own controls raised: never a reason to try another target. */
const NOT_A_RUNTIME_FAILURE = /\b(approval|policy|security|verification|cancel\w*|abort\w*)\b/;
/** What classify() has no category for. */
const FAILOVER_ONLY_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ["billing", /\b(402|billing|payment|credit.*exhausted)\b/],
  ["model_not_found", /\b(404|model not found|invalid model|unknown model)\b/],
  ["timeout", /\bruntime reconstruction unavailable\b/],
];
const SERVER_ERROR = /\b(500|502|server error|internal server error|bad gateway|upstream error)\b/;
const FAILOVER_BY_CATEGORY: Partial<Record<ErrorCategory, string>> = {
  rateLimit: "rate_limit", auth: "auth", timeout: "timeout", network: "timeout",
};

/**
 * The failover category of a runtime failure, read through classify() in
 * resilience-policy.ts, the one owner of what kind of failure this is. Only
 * what that has no category for is matched here. Its own regex used to
 * disagree: `content_filter` could never match once underscores became
 * spaces, a plain quota error did not fail over, and any "capacity" did.
 */
export function normalizeRuntimeFailure(code: string, message = ""): string | null {
  const text = `${code} ${message}`;
  const words = text.toLowerCase().replace(/[_-]+/g, " ");
  if (NOT_A_RUNTIME_FAILURE.test(words)) return null;
  for (const [failure, signal] of FAILOVER_ONLY_SIGNALS) if (signal.test(words)) return failure;
  const status = Number(/^(?:http[_ ]?)?([1-5]\d\d)\b/i.exec(code)?.[1]) || undefined;
  const category = classify({ message: text, ...(status ? { statusCode: status } : {}) });
  if (category === "overload") return SERVER_ERROR.test(words) ? "server_error" : "overloaded";
  return FAILOVER_BY_CATEGORY[category] ?? null;
}
