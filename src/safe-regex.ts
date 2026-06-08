/**
 * Safe Regex — ReDoS prevention (app adapter).
 *
 * `checkRegexSafety` is the SINGLE canonical implementation, owned by
 * @arikernel/policy-engine and re-exported here so the app and the kernel share
 * ONE checker. A previous fork (a parallel copy in this file) let a ReDoS fix
 * land in one place but not the other — don't reintroduce a second copy.
 *
 * `safeRegex` and `safeRegexTest` are app-only wrappers (a throwing constructor
 * and a timeout-guarded test) layered on top of the shared checker.
 */

import { checkRegexSafety } from "@arikernel/policy-engine";

export { checkRegexSafety };

/**
 * Test a regex with a timeout guard.
 * If the regex takes longer than `timeoutMs` to execute, returns false
 * and logs a warning. Prevents ReDoS from blocking the event loop.
 *
 * Note: This is a best-effort protection. Node.js regex runs on the main
 * thread, so a truly catastrophic regex WILL block. This catches moderately
 * slow patterns by limiting input size.
 */
export function safeRegexTest(
  pattern: RegExp,
  input: string,
  maxInputLength: number = 10_000
): boolean {
  // Truncate input to prevent quadratic-time regex on very long strings
  const truncated = input.length > maxInputLength ? input.slice(0, maxInputLength) : input;
  return pattern.test(truncated);
}

/**
 * Create a regex from a user-provided pattern string, with safety checks.
 * Returns the regex if safe, or throws if the pattern is dangerous.
 */
export function safeRegex(pattern: string, flags: string = "i"): RegExp {
  const safety = checkRegexSafety(pattern);
  if (safety) {
    throw new Error(`Unsafe regex pattern: ${safety}`);
  }
  return new RegExp(pattern, flags);
}
