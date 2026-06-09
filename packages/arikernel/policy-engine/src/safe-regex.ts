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
 */

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
 * Find the index of the `]` that closes a character class opened at `start`
 * (`pattern[start] === '['`), or -1 if unterminated. A leading `^` and a `]`
 * appearing as the first class member are literals, not the terminator.
 */
function findCharClassEnd(pattern: string, start: number): number {
	let i = start + 1;
	if (pattern[i] === "^") i++;
	if (pattern[i] === "]") i++; // `]` as the first member is a literal
	for (; i < pattern.length; i++) {
		if (pattern[i] === "\\") {
			i++;
			continue;
		}
		if (pattern[i] === "]") return i;
	}
	return -1;
}

/**
 * Classify the quantifier (if any) at `idx` and report where it ends. Only
 * `*`, `+`, and the open-ended `{n,}` can repeat UNBOUNDEDLY and so drive
 * polynomial/exponential backtracking; `?`, `{n}`, and `{n,m}` are bounded and
 * cannot, so they don't count toward the adjacency check. A trailing lazy `?`
 * (e.g. `a*?`) is consumed but doesn't change the class.
 */
function quantifierAt(pattern: string, idx: number): { end: number; unbounded: boolean } {
	const ch = pattern[idx];
	if (ch === "*" || ch === "+") {
		const end = pattern[idx + 1] === "?" ? idx + 2 : idx + 1;
		return { end, unbounded: true };
	}
	if (ch === "?") {
		const end = pattern[idx + 1] === "?" ? idx + 2 : idx + 1;
		return { end, unbounded: false };
	}
	if (ch === "{") {
		const m = /^\{\d*(,\d*)?\}/.exec(pattern.slice(idx));
		if (m) {
			const unbounded = /,\}$/.test(m[0]); // `{n,}` — no upper bound
			const after = idx + m[0].length;
			const end = pattern[after] === "?" ? after + 1 : after;
			return { end, unbounded };
		}
	}
	return { end: idx, unbounded: false };
}

/**
 * Detect two (or more) ADJACENT unbounded-quantified atoms whose first-character
 * sets overlap — the sequential-sibling catastrophic-backtracking family
 * (`a*a*…b`, `.+.+`, `\d*\d*…x`, `[0-9]*[0-9]*…X`). With k adjacent repeats over
 * the same character, a priming run of n chars followed by one non-matching char
 * backtracks in O(n^k); even two siblings are quadratic, which is enough to
 * freeze the synchronous, uninterruptible kernel matcher.
 *
 * Adjacency is broken by any unquantified (or bounded-quantified) atom, `|`,
 * group parens, or an anchor — so the extremely common `.*foo.*` shape is
 * correctly NOT flagged (the literal `foo` separates the two `.*`). Quantified
 * GROUPS are deliberately left to the nested / overlapping-alternation detectors;
 * this pass reasons only about atom-level siblings.
 *
 * Reuses firstCharSet/setsOverlap and inherits their fail-closed posture: an
 * un-enumerable atom (`.`, `\d`, negated class, …) overlaps with everything, so
 * `\d*\d*` and `.+.+` reject. Over-rejecting an operator-authored policy pattern
 * is the accepted trade (see the file header).
 */
function hasAdjacentUnboundedQuantifiers(pattern: string): boolean {
	// First-char set of the previous token IFF it was an unbounded-quantified
	// atom ending exactly at `prevEnd`; `undefined` means the adjacency chain is
	// broken (no immediately-preceding repeating atom).
	let prevSet: Set<string> | null | undefined = undefined;
	let prevEnd = -1;

	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];

		// Anchors, alternation, and group boundaries break adjacency. (Quantified
		// groups are handled elsewhere; we don't reason through them here.)
		if (ch === "|" || ch === "(" || ch === ")" || ch === "^" || ch === "$") {
			prevSet = undefined;
			i++;
			continue;
		}

		// Identify the atom at `i` and where its body ends.
		let atom: string;
		let atomEnd: number;
		if (ch === "\\") {
			atom = pattern.slice(i, i + 2);
			atomEnd = i + 2;
		} else if (ch === "[") {
			const close = findCharClassEnd(pattern, i);
			if (close === -1) return false; // unterminated class → bail conservatively
			atom = pattern.slice(i, close + 1);
			atomEnd = close + 1;
		} else {
			atom = ch;
			atomEnd = i + 1;
		}

		const q = quantifierAt(pattern, atomEnd);
		if (!q.unbounded) {
			// Unquantified or bounded-quantified atom → can't drive unbounded
			// backtracking and breaks the adjacency chain.
			prevSet = undefined;
			i = q.end;
			continue;
		}

		const firstSet = firstCharSet(atom);
		if (prevSet !== undefined && i === prevEnd && setsOverlap(prevSet, firstSet)) {
			return true;
		}
		prevSet = firstSet;
		prevEnd = q.end;
		i = q.end;
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
