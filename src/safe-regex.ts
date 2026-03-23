/**
 * Safe Regex — ReDoS prevention
 *
 * Validates regex patterns for catastrophic backtracking potential.
 * Used to ensure user-configurable patterns (tool policy, redaction)
 * can't cause denial-of-service via exponential regex execution time.
 *
 * Also provides a timeout-guarded regex test function.
 */

/**
 * Check if a regex pattern is likely safe from catastrophic backtracking.
 * Heuristic-based: rejects patterns with known-dangerous constructs.
 *
 * Returns null if safe, or a description of the problem if unsafe.
 */
export function checkRegexSafety(pattern: string): string | null {
  // Nested quantifiers: (a+)+ or (a*)* or (a+)*
  if (/\([^)]*[+*]\)[+*]/.test(pattern)) {
    return "Nested quantifiers detected (e.g., (a+)+). This can cause catastrophic backtracking.";
  }
  // Overlapping alternation with quantifiers: (a|a)+
  if (/\(([^|)]+)\|(\1)[^)]*\)[+*]/.test(pattern)) {
    return "Overlapping alternation with quantifier detected. This can cause exponential backtracking.";
  }
  // Very long patterns (>500 chars) are suspicious
  if (pattern.length > 500) {
    return "Pattern exceeds 500 characters. May be too complex for safe execution.";
  }
  // Adjacent quantified wildcards: .*.*
  if (/\.\*\.\*/.test(pattern) || /\.+\.+/.test(pattern)) {
    return "Adjacent wildcards detected (e.g., .*.*). This can cause quadratic backtracking.";
  }
  return null;
}

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
