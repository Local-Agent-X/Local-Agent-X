// Tool-call error types and transient-error classification.
// ToolBlocked is re-exported from pre-dispatch so consumers don't reach
// across the boundary into tools/.

export { ToolBlocked } from "../tools/pre-dispatch.js";

const TRANSIENT_PATTERNS = [
  "timeout",
  "timed out",
  "etimedout",
  "econnrefused",
  "econnreset",
  "enotfound",
  "rate limit",
  "429",
  "503",
  "504",
  "network",
];

export function isTransientError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_PATTERNS.some(p => msg.includes(p));
}
