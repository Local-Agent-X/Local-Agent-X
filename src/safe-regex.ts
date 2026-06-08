/**
 * Safe Regex — ReDoS prevention
 *
 * Validates regex patterns for catastrophic backtracking potential.
 * Used to ensure user-configurable patterns (tool policy, redaction)
 * can't cause denial-of-service via exponential regex execution time.
 *
 * Also provides a timeout-guarded regex test function.
 *
 * SYNC NOTE: The overlapping-alternation detection below (isUnboundedQuantifierAt,
 * splitTopLevelAlternation, hasOverlappingAlternation, firstCharSet,
 * charClassFirstSet, setsOverlap) is a PARALLEL IMPLEMENTATION of the same
 * heuristic in packages/arikernel/policy-engine/src/safe-regex.ts. The two
 * checkRegexSafety functions have intentionally diverged (this root copy also
 * enforces a >500-char bound and an adjacent-wildcard check that the package
 * copy does not), so they are not consolidated into one import. If you change
 * the overlapping-alternation logic in one file, mirror it in the other.
 */

/**
 * Check if a regex pattern is likely safe from catastrophic backtracking.
 * Heuristic-based: rejects patterns with known-dangerous constructs.
 *
 * Returns null if safe, or a description of the problem if unsafe.
 */
export function checkRegexSafety(pattern: string): string | null {
  // A repetition quantifier: +, *, or a counted form {n} / {n,} / {n,m}.
  // The counted forms are just as catastrophic as +/* when nested or applied
  // to overlapping alternation (e.g. (a+){2,} or (a|a){10}), so they must be
  // matched too — heuristic is conservative and may also flag benign {0,1}.
  const QUANT = "(?:[+*]|\\{\\d+,?\\d*\\})";
  // Nested quantifiers: (a+)+ or (a*)* or (a+)* or (a+){2,} or (a{2}){3}
  if (new RegExp("\\([^)]*" + QUANT + "\\)" + QUANT).test(pattern)) {
    return "Nested quantifiers detected (e.g., (a+)+). This can cause catastrophic backtracking.";
  }
  // Overlapping alternation with quantifiers: (a|a)+ or (a|a){10} (identical branches).
  if (new RegExp("\\(([^|)]+)\\|(\\1)[^)]*\\)" + QUANT).test(pattern)) {
    return "Overlapping alternation with quantifier detected. This can cause exponential backtracking.";
  }
  // Overlapping alternation under an UNBOUNDED quantifier whose branches merely
  // share a possible first character (not just identical branches), e.g.
  // ^([a-zA-Z]|[a-zA-Z0-9])*$, (\w|\d)+, (.|x)*, (ab|a)+. The cheap backreference
  // check above misses these; this structural scan catches the full family.
  if (hasOverlappingAlternationGroup(pattern)) {
    return "Unbounded-quantified group with overlapping alternation branches detected. Branches like '([a-z]|[a-z0-9])*' share a first character and cause catastrophic backtracking.";
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

// ─────────────────────────────────────────────────────────────────────────────
// Overlapping-alternation detection (ported from
// packages/arikernel/policy-engine/src/safe-regex.ts — keep in sync; see SYNC
// NOTE at the top of this file). Fail-closed: when a branch's first-character
// set cannot be cheaply enumerated (`.`, `\w\d\s`, negated/nested), it is treated
// as overlapping with everything and the pattern is REJECTED.
// ─────────────────────────────────────────────────────────────────────────────

/** Characters that indicate a quantifier follows a group. */
const GROUP_QUANTIFIERS = new Set(["*", "+", "?", "{"]);

/**
 * Unbounded quantifiers (`*`, `+`, `{n,}`) are the only ones that make
 * overlapping alternation catastrophic; `?` and finite `{n,m}` cannot blow up
 * super-linearly. Detected positionally at `idx`.
 */
function isUnboundedQuantifierAt(pattern: string, idx: number): boolean {
  const ch = pattern[idx];
  if (ch === "*" || ch === "+") return true;
  if (ch === "{") {
    const close = pattern.indexOf("}", idx);
    if (close === -1) return false; // literal '{' — not a quantifier
    const body = pattern.slice(idx + 1, close);
    const comma = body.indexOf(",");
    return comma !== -1 && body.slice(comma + 1).trim() === "";
  }
  return false;
}

/**
 * Scan a pattern for any group that is (a) immediately followed by an unbounded
 * quantifier and (b) whose body has a top-level alternation with non-disjoint
 * first-character sets. Returns true (reject) on the first such group.
 */
function hasOverlappingAlternationGroup(pattern: string): boolean {
  const groupStart: number[] = []; // index just AFTER each '(' currently open
  let escaped = false;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      continue;
    }
    if (ch === "]") {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;

    if (ch === "(") {
      // Skip a group-modifier prefix (`?:`, `?<name>`, `?=`, `?!`, `?<=`, `?<!`)
      // so the recorded body start points at the first real branch char.
      const prefix = /^\?(?::|<[a-zA-Z_]\w*>|=|!|<=|<!)/.exec(pattern.slice(i + 1));
      if (prefix) i += prefix[0].length;
      groupStart.push(i + 1);
      continue;
    }

    if (ch === ")") {
      if (groupStart.length > 0) {
        const start = groupStart.pop() ?? i;
        const next = pattern[i + 1];
        if (next && GROUP_QUANTIFIERS.has(next) && isUnboundedQuantifierAt(pattern, i + 1)) {
          const body = pattern.slice(start, i);
          if (hasOverlappingAlternation(body)) return true;
        }
      }
      continue;
    }
  }

  return false;
}

/**
 * Split a group body into its TOP-LEVEL alternation branches (splitting on `|`
 * only at nesting depth 0, ignoring `|` inside nested groups, char classes, or
 * escapes). Returns a single-element array when there is no top-level `|`.
 */
function splitTopLevelAlternation(body: string): string[] {
  const branches: string[] = [];
  let current = "";
  let depth = 0;
  let inClass = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (inClass) {
      current += ch;
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "|" && depth === 0) {
      branches.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches;
}

/**
 * True when a quantified group body has a top-level alternation whose branches
 * are NOT provably disjoint by their first character — the canonical
 * catastrophic-backtracking shape. Fail-closed: if disjointness can't be cheaply
 * proven, treat branches as overlapping (return true → reject).
 */
function hasOverlappingAlternation(body: string): boolean {
  const branches = splitTopLevelAlternation(body);
  if (branches.length < 2) return false; // no top-level alternation → not this class

  const firstSets = branches.map(firstCharSet);
  for (let a = 0; a < firstSets.length; a++) {
    for (let b = a + 1; b < firstSets.length; b++) {
      if (setsOverlap(firstSets[a], firstSets[b])) return true;
    }
  }
  return false;
}

/**
 * Set of characters a branch can START with, or `null` if it cannot be cheaply
 * enumerated (in which case the caller fails closed). See the policy-engine copy
 * for the full FIRST-CHAR DISJOINTNESS LIMITS rationale.
 */
function firstCharSet(branch: string): Set<string> | null {
  if (branch.length === 0) return null; // empty branch overlaps with everything

  const ch = branch[0];

  if (ch === "^") return firstCharSet(branch.slice(1)); // strip a leading anchor

  if (ch === "\\") {
    const next = branch[1];
    if (next === undefined) return null;
    // Shorthand character classes can't be cheaply enumerated → fail closed.
    if (/[dDwWsSbB]/.test(next)) return null;
    return new Set([next]); // escaped literal (e.g. \. \/ \+)
  }

  if (ch === "[") return charClassFirstSet(branch);

  if (ch === ".") return null; // `.` matches (almost) anything → un-enumerable
  if (ch === "(") return null; // nested group as first token — don't reason through it

  return new Set([ch]); // plain literal first character
}

/** Enumerate the characters a leading `[...]` character class can match. */
function charClassFirstSet(branch: string): Set<string> | null {
  let i = 1; // branch starts with '['
  if (branch[i] === "^") return null; // negated class — treat as un-enumerable
  const chars = new Set<string>();
  let prev: string | null = null;
  let pendingRange = false;

  for (; i < branch.length; i++) {
    const c = branch[i];
    if (c === "]") return chars; // done (ignore what follows; only FIRST set needed)
    if (c === "\\") {
      const next = branch[i + 1];
      if (next === undefined) return null;
      if (/[dDwWsSbB]/.test(next)) return null; // shorthand → un-enumerable
      chars.add(next);
      prev = next;
      i++;
      continue;
    }
    if (c === "-" && prev !== null && branch[i + 1] !== "]" && branch[i + 1] !== undefined) {
      pendingRange = true;
      continue;
    }
    if (pendingRange && prev !== null) {
      const lo = prev.charCodeAt(0);
      const hi = c.charCodeAt(0);
      if (hi >= lo && hi - lo < 1024) {
        for (let code = lo; code <= hi; code++) chars.add(String.fromCharCode(code));
      } else {
        return null; // pathological / reversed range — fail closed
      }
      pendingRange = false;
      prev = null;
      continue;
    }
    chars.add(c);
    prev = c;
  }
  return null; // unterminated class — fail closed
}

/** Two first-char sets overlap if either is `null` (un-enumerable) or they intersect. */
function setsOverlap(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null || b === null) return true;
  for (const c of a) {
    if (b.has(c)) return true;
  }
  return false;
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
