/**
 * The named ReDoS-pattern detectors used by the safe-regex scanner:
 *   - hasOverlappingAlternation — overlapping alternation under a repeating
 *     quantifier (`(a|a)*`, `([a-z]|[a-z0-9])+`).
 *   - hasAdjacentUnboundedQuantifiers — the sequential-sibling family
 *     (`a*a*…b`, `.+.+`, `\d*\d*…x`).
 * Both reuse the fail-closed first-char primitives from ./first-char-analysis.
 *
 * Part of the safe-regex checker; see ./safe-regex.ts for the full rationale.
 */

import { findCharClassEnd, firstCharSet, setsOverlap } from "./first-char-analysis.js";

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
export function hasOverlappingAlternation(body: string): boolean {
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
export function hasAdjacentUnboundedQuantifiers(pattern: string): boolean {
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
