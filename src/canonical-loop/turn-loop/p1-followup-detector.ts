/**
 * P-1 refinement: does a mutation turn's narration PROMISE a post-mutation
 * follow-up?
 *
 * The P-1 sink (p1-metrics.ts) counts how often the `mutationCommitted`
 * shortcut is the sole reason a turn terminates. But `terminated` overcounts
 * the actual harm: it fires whether the model said "wrote the file. done." (a
 * trailing tool_use, nothing lost) or "I'll write the file, then run the
 * tests" (a real follow-up cut off). This classifier splits the two so the
 * durable ratio measures LOST WORK, not shortcut fires.
 *
 * Deliberately conservative-leaning on recall: we're measuring, and a missed
 * promise silently understates the case for the surgical fix. Precision guards
 * exist only for the common closers ("let me know", "I'll be here") that read
 * as promises but commit to nothing on-task.
 *
 * Pure + side-effect free so it's trivially testable and safe on the turn path.
 */

/**
 * Forward-commitment lead-ins: the model announcing a NEXT action. All matched
 * case-insensitively. Past-tense reports ("I ran the tests", "verified the
 * build") are deliberately absent — those describe work already done, so no
 * follow-up is pending.
 */
const PROMISE_PATTERNS: RegExp[] = [
	/\bI['’]?ll\b/i, // I'll
	/\bI will\b/i,
	/\bI['’]?m going to\b/i,
	/\b(?:going|gonna) to\b/i,
	/\bgonna\b/i,
	/\blet me\b/i,
	/\bnext[, ]+I\b/i,
	/\bnext step\b/i,
	/\bthen\s+(?:I|we|run|let|test|verify|check|build|confirm)\b/i,
	/\bnow\s+(?:I|let|run)\b/i,
	/\bafter (?:that|this)\b/i,
	/\bfollowed by\b/i,
	/\bproceed(?:ing)? to\b/i,
];

/**
 * Closers that pattern-match a promise but commit to nothing on-task. Stripped
 * before detection so they can't inflate the count.
 */
const FALSE_PROMISE_PATTERNS: RegExp[] = [
	/\blet me know\b/gi,
	/\bI['’]?ll be (?:here|around|standing by)\b/gi,
	/\bI['’]?ll wait\b/gi,
];

/**
 * True when `narration` announces a post-mutation action the terminating
 * shortcut would cut off. Empty / whitespace text is never a promise.
 */
export function narrationPromisesFollowup(narration: string): boolean {
	const text = narration?.trim();
	if (!text) return false;
	let scrubbed = text;
	for (const p of FALSE_PROMISE_PATTERNS) scrubbed = scrubbed.replace(p, " ");
	return PROMISE_PATTERNS.some((p) => p.test(scrubbed));
}
