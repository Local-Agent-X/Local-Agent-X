/**
 * Simple static analysis to detect regex patterns at risk of catastrophic backtracking.
 *
 * Rejects two families of ReDoS-prone patterns:
 *   1. Nested quantifiers, e.g. (a+)+, (a*)*b, (a|b+)* — a quantifier applied to a
 *      group that itself contains a quantifier.
 *   2. Overlapping alternation under a repeating quantifier, e.g. (a|a)*,
 *      ([a-zA-Z]|[a-zA-Z0-9])*, (\w|\d)+, (a|a){10} — a group with a top-level
 *      alternation, quantified by *, +, or a counted {n}/{n,}/{n,m} (anything but
 *      the non-repeating ?), whose branches share a possible first character.
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
 * It also rejects two cheaper shapes: a pattern longer than 500 chars (too
 * complex to analyze/run safely) and adjacent unbounded quantifiers over
 * overlapping character sets (.*.* / a*a*…b / \d*\d*…x — polynomial
 * backtracking; the sequential-sibling cousin of the nested-quantifier shape).
 *
 * Combined with the runtime MAX_REGEX_INPUT_LENGTH bound in matcher.ts,
 * this provides defense-in-depth against regex-based DoS.
 *
 * SINGLE SOURCE OF TRUTH: this is the one regex-safety checker for the whole
 * project. The root app re-exports it (src/safe-regex.ts) rather than keeping a
 * parallel copy — a previous fork let a ReDoS fix land in one place but not the
 * other. Do not reintroduce a second implementation.
 *
 * This module is the entry point / barrel. The fail-closed first-char primitives
 * live in ./first-char-analysis and the named ReDoS-pattern detectors in
 * ./redos-detectors; both are private to this checker.
 */

import {
	hasAdjacentUnboundedQuantifiers,
	hasOverlappingAlternation,
} from "./redos-detectors.js";

/** Characters that indicate a quantifier follows a group. */
const QUANTIFIERS = new Set(["*", "+", "?", "{"]);

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

	// A very long pattern is suspicious and expensive to analyze/run — reject
	// before the structural scan.
	if (pattern.length > 500) {
		return `Regex pattern exceeds 500 characters — too complex for safe execution (potential ReDoS).`;
	}

	// Adjacent unbounded quantifiers over overlapping characters — the
	// sequential-sibling catastrophic family (`a*a*…b`, `.+.+`, `\d*\d*…x`,
	// `[0-9]*[0-9]*…X`). With k such siblings a priming run backtracks in
	// O(n^k); even two are quadratic, enough to freeze the synchronous,
	// uninterruptible kernel matcher. Subsumes the old `.*.*`/`.+.+` literal
	// guard — which was itself a no-op: `/\.+\.+/` matched runs of dots, not the
	// string `.+.+`.
	if (hasAdjacentUnboundedQuantifiers(pattern)) {
		return `Regex pattern '${pattern}' contains adjacent unbounded quantifiers over overlapping characters (e.g. 'a*a*…b', '.+.+', '\\d*\\d*…') — polynomial backtracking risk. Rewrite so adjacent repeats cover disjoint characters, or collapse them into a single quantifier.`;
	}

	// Detect nested quantifiers by tracking group depth and quantifier presence.
	// We also record where each open paren started so that, when a group closes
	// under an unbounded quantifier, we can re-scan its body for overlapping
	// top-level alternation.
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
					// Overlapping alternation under a REPEATING quantifier — `*`, `+`, or a
					// counted form `{n}`/`{n,}`/`{n,m}` — is catastrophic: a long priming run
					// can be split between branches that share a first character in
					// exponentially many ways. `?` (zero-or-one) is the only quantifier that
					// cannot repeat, so it is exempt. Checked BEFORE the nested case so an
					// alternation group like `(a|a?)+` reports the more specific overlap cause.
					if (next !== "?") {
						const body = pattern.slice(start, i);
						if (hasOverlappingAlternation(body)) {
							return `Regex pattern '${pattern}' contains a quantified group with overlapping alternation branches (potential ReDoS). Branches like '(a|a)*' or '([a-z]|[a-z0-9])*' share a first character and cause catastrophic backtracking. Rewrite the rule so the alternation branches are disjoint or remove the quantifier.`;
						}
					}

					if (innerHasQuantifier) {
						return `Regex pattern '${pattern}' contains nested quantifiers (potential ReDoS). A quantified group contains a quantifier — this can cause catastrophic backtracking.`;
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
		}
	}

	return null;
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
