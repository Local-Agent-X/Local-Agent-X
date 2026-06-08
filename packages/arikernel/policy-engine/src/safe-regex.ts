/**
 * Simple static analysis to detect regex patterns at risk of catastrophic backtracking.
 *
 * Rejects two families of ReDoS-prone patterns:
 *   1. Nested quantifiers, e.g. (a+)+, (a*)*b, (a|b+)* — a quantifier applied to a
 *      group that itself contains a quantifier.
 *   2. Overlapping alternation under an unbounded quantifier, e.g. (a|a)*,
 *      ([a-zA-Z]|[a-zA-Z0-9])*, (\w|\d)+ — a group with a top-level alternation,
 *      quantified by *, +, or {n,}, whose branches share a possible first character.
 *      These cause catastrophic backtracking on a long priming run followed by one
 *      non-matching char (the canonical "evil regex" shape).
 *
 * This is a heuristic — it cannot catch all vulnerable patterns, but it covers the
 * most common attack vectors. For (2) it is deliberately CONSERVATIVE (fail-closed):
 * when it cannot cheaply prove the alternation branches' first-character sets are
 * disjoint, it REJECTS. Over-rejecting an operator-authored policy pattern is an
 * acceptable trade — the operator gets a clear error and rewrites the rule — versus
 * letting a kernel-freezing pattern load. See FIRST-CHAR DISJOINTNESS LIMITS below.
 *
 * Combined with the runtime MAX_REGEX_INPUT_LENGTH bound in matcher.ts,
 * this provides defense-in-depth against regex-based DoS.
 *
 * SYNC NOTE: The overlapping-alternation helpers below (isUnboundedQuantifierAt,
 * splitTopLevelAlternation, hasOverlappingAlternation, firstCharSet,
 * charClassFirstSet, setsOverlap) are mirrored as a PARALLEL IMPLEMENTATION in
 * the root app at src/safe-regex.ts. The two checkRegexSafety functions have
 * intentionally diverged (the root copy also enforces a >500-char bound and an
 * adjacent-wildcard check), so they are not a single shared import. If you change
 * the overlapping-alternation logic here, mirror it in src/safe-regex.ts.
 */

/** Characters that indicate a quantifier follows a group. */
const QUANTIFIERS = new Set(["*", "+", "?", "{"]);

/**
 * Unbounded quantifiers — the only ones that make overlapping alternation
 * catastrophic. `?` and `{n,m}` with a finite upper bound cannot blow up
 * super-linearly, so we don't flag alternation-overlap under them.
 *
 * Detected positionally: `*`, `+`, or `{` that opens an open-ended `{n,}`.
 */
function isUnboundedQuantifierAt(pattern: string, idx: number): boolean {
	const ch = pattern[idx];
	if (ch === "*" || ch === "+") return true;
	if (ch === "{") {
		// Open-ended range like {2,} or {0,} is unbounded; {2,5} or {3} is bounded.
		const close = pattern.indexOf("}", idx);
		if (close === -1) return false; // literal '{' — not a quantifier
		const body = pattern.slice(idx + 1, close);
		// Unbounded iff it contains a comma with nothing after it (e.g. "2," or ",").
		const comma = body.indexOf(",");
		return comma !== -1 && body.slice(comma + 1).trim() === "";
	}
	return false;
}

/**
 * Check if a regex pattern has nested quantifiers (a quantifier applied to a
 * group that itself contains a quantifier). This is the classic ReDoS pattern.
 *
 * Returns an error message if unsafe, or null if the pattern appears safe.
 */
export function checkRegexSafety(pattern: string): string | null {
	try {
		new RegExp(pattern);
	} catch {
		// Invalid regex patterns are handled at runtime by UnsafeMatchError in matcher.ts.
		// Don't reject at load time — allow the fail-closed runtime behavior to apply.
		return null;
	}

	// Detect nested quantifiers by tracking group depth and quantifier presence.
	// We also record where each open paren started so that, when a group closes
	// under an unbounded quantifier, we can re-scan its body for overlapping
	// top-level alternation.
	let quantifierInCurrentGroup = false;
	const groupHasQuantifier: boolean[] = [];
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
			groupHasQuantifier.push(false);
			// Skip a group-modifier prefix (`?:`, `?<name>`, `?=`, `?!`, `?<=`,
			// `?<!`) so the leading `?` is NOT miscounted as a quantifier and the
			// recorded body start points at the first real branch char.
			const prefix = /^\?(?::|<[a-zA-Z_]\w*>|=|!|<=|<!)/.exec(pattern.slice(i + 1));
			if (prefix) i += prefix[0].length;
			groupStart.push(i + 1);
			continue;
		}

		if (ch === ")") {
			if (groupStart.length > 0) {
				const innerHasQuantifier = groupHasQuantifier.pop() ?? false;
				const start = groupStart.pop() ?? i;

				// Check if the group itself is quantified
				const next = pattern[i + 1];
				if (next && QUANTIFIERS.has(next)) {
					if (innerHasQuantifier) {
						return `Regex pattern '${pattern}' contains nested quantifiers (potential ReDoS). A quantified group contains a quantifier — this can cause catastrophic backtracking.`;
					}

					// Overlapping-alternation check: only unbounded quantifiers
					// (*, +, {n,}) can produce catastrophic backtracking here.
					if (isUnboundedQuantifierAt(pattern, i + 1)) {
						const body = pattern.slice(start, i);
						if (hasOverlappingAlternation(body)) {
							return `Regex pattern '${pattern}' contains an unbounded-quantified group with overlapping alternation branches (potential ReDoS). Branches like '(a|a)*' or '([a-z]|[a-z0-9])*' share a first character and cause catastrophic backtracking. Rewrite the rule so the alternation branches are disjoint or remove the quantifier.`;
						}
					}

					// Mark parent group as having a quantifier
					if (groupHasQuantifier.length > 0) {
						groupHasQuantifier[groupHasQuantifier.length - 1] = true;
					}
				}
			}
			continue;
		}

		if (QUANTIFIERS.has(ch)) {
			if (groupHasQuantifier.length > 0) {
				groupHasQuantifier[groupHasQuantifier.length - 1] = true;
			}
			quantifierInCurrentGroup = true;
		}
	}

	return null;
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
 * Decide whether a quantified group body has a top-level alternation whose
 * branches are NOT provably disjoint by their first character — the canonical
 * catastrophic-backtracking shape. Fail-closed: if we cannot cheaply prove
 * disjointness, we treat the branches as overlapping (return true → reject).
 */
function hasOverlappingAlternation(body: string): boolean {
	// `body` already excludes any group-modifier prefix (`?:`, `?<name>`,
	// lookaround) — the main scanner skips it when it records the group start.
	const branches = splitTopLevelAlternation(body);
	if (branches.length < 2) return false; // no top-level alternation → not this class

	const firstSets = branches.map(firstCharSet);

	// If ANY pair of branches can begin with the same character, the unbounded
	// quantifier can split a matching prefix between branches in exponentially
	// many ways → catastrophic. A `null` first-set means "could be anything we
	// can't cheaply enumerate" (e.g. `.`, `\w`, a nested group, an empty branch);
	// fail closed and treat it as overlapping with everything.
	for (let a = 0; a < firstSets.length; a++) {
		for (let b = a + 1; b < firstSets.length; b++) {
			if (setsOverlap(firstSets[a], firstSets[b])) return true;
		}
	}
	return false;
}

/**
 * Compute the set of characters a branch can START with, or `null` if it cannot
 * be cheaply/soundly enumerated (in which case the caller fails closed).
 *
 * FIRST-CHAR DISJOINTNESS LIMITS — this is intentionally simple and conservative:
 *  - Plain literal first char (incl. escaped literal like `\.`): the singleton set.
 *  - Character class `[...]`: enumerated, with `a-z` style ranges expanded; a
 *    leading `^` negation makes it un-enumerable (returns null → fail closed).
 *  - Shorthand classes (`\w`, `\d`, `\s`, `.`, `\W`, ...): un-enumerable → null.
 *  - Anything starting with a group `(` or an empty branch: null.
 * Returning null biases toward REJECTION, which is the desired fail-closed posture
 * for operator-authored policy patterns.
 */
function firstCharSet(branch: string): Set<string> | null {
	if (branch.length === 0) return null; // empty branch overlaps with everything

	const ch = branch[0];

	// Strip a leading anchor so e.g. an anchored branch still classifies on its
	// first real char (anchors don't appear inside groups normally, but be safe).
	if (ch === "^") return firstCharSet(branch.slice(1));

	if (ch === "\\") {
		const next = branch[1];
		if (next === undefined) return null;
		// Shorthand character classes can't be cheaply enumerated → fail closed.
		if (/[dDwWsSbB]/.test(next)) return null;
		// Escaped literal (e.g. \. \/ \+): the literal character itself.
		return new Set([next]);
	}

	if (ch === "[") {
		return charClassFirstSet(branch);
	}

	// `.` matches (almost) anything → un-enumerable.
	if (ch === ".") return null;

	// A nested group as the first token — don't try to reason through it.
	if (ch === "(") return null;

	// Plain literal first character.
	return new Set([ch]);
}

/** Enumerate the characters a leading `[...]` character class can match. */
function charClassFirstSet(branch: string): Set<string> | null {
	// branch starts with '['. Find the matching ']'.
	let i = 1;
	if (branch[i] === "^") return null; // negated class — treat as un-enumerable
	const chars = new Set<string>();
	let prev: string | null = null;
	let pendingRange = false;

	for (; i < branch.length; i++) {
		const c = branch[i];
		if (c === "]") {
			// Done. (Ignore whatever follows; we only need the FIRST char set.)
			return chars;
		}
		if (c === "\\") {
			const next = branch[i + 1];
			if (next === undefined) return null;
			// Shorthand inside a class makes it un-enumerable.
			if (/[dDwWsSbB]/.test(next)) return null;
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
 * Validate all regex patterns in a set of policy rules.
 * Returns an array of error messages (empty if all patterns are safe).
 */
export function validatePolicyRegexSafety(
	rules: Array<{ id: string; match: { parameters?: Record<string, { pattern?: string }> } }>,
): string[] {
	const errors: string[] = [];

	for (const rule of rules) {
		if (!rule.match.parameters) continue;

		for (const [key, matcher] of Object.entries(rule.match.parameters)) {
			if (!matcher.pattern) continue;

			const error = checkRegexSafety(matcher.pattern);
			if (error) {
				errors.push(`Rule '${rule.id}', parameter '${key}': ${error}`);
			}
		}
	}

	return errors;
}
