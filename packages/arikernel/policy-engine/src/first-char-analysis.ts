/**
 * Shared structural primitives for the ReDoS safety checker: first-character-set
 * enumeration, set-overlap comparison, and character-class boundary scanning.
 * Both ReDoS detectors (overlapping-alternation and adjacent-unbounded) reuse
 * these — they are the single source of the fail-closed disjointness reasoning.
 *
 * Part of the safe-regex checker; see ./safe-regex.ts for the full rationale.
 */

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
export function firstCharSet(branch: string): Set<string> | null {
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
export function setsOverlap(a: Set<string> | null, b: Set<string> | null): boolean {
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
export function findCharClassEnd(pattern: string, start: number): number {
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
