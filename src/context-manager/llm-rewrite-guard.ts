/**
 * llm-rewrite-guard — deterministic validation for LLM rewrite/summarize
 * outputs, plus a bounded retry ladder.
 *
 * Motivation: a looping or otherwise degenerate model output (the classic
 * repeated-paragraph failure mode) is worse than no output at all — a
 * compaction summary made of the same 200 chars repeated 40 times silently
 * replaces real history. detectDegenerateRewrite catches that class without
 * an LLM call; guardedRewrite gives the model one structured chance to fix
 * itself before the caller falls back to its null path (which, for the
 * compaction seam, feeds the existing circuit breaker in
 * canonical-loop/turn-loop/compact-history.ts).
 */

const WINDOW_SIZE = 200;
const SAMPLE_COUNT = 50;
/** Below this many distinct windows the duplicate ratio is noise, not signal. */
const MIN_WINDOWS_FOR_LOOP_CHECK = 10;
const DUPLICATE_RATIO_THRESHOLD = 0.4;
const MAX_LINE_CHARS = 10_000;

export interface DegenerateVerdict {
	degenerate: boolean;
	reason?: string;
}

/**
 * Deterministic degenerate-output detection. No LLM, no randomness — window
 * sample offsets are evenly spaced so the same text always yields the same
 * verdict.
 *
 * Flags:
 *  - empty / whitespace-only output
 *  - any single line over 10k chars (runaway single-line generation)
 *  - looping output: of ~50 sampled 200-char windows, >40% duplicate another
 *    sampled window
 */
export function detectDegenerateRewrite(text: string): DegenerateVerdict {
	if (text.trim().length === 0) {
		return { degenerate: true, reason: "output was empty or whitespace-only" };
	}

	for (const line of text.split("\n")) {
		if (line.length > MAX_LINE_CHARS) {
			return {
				degenerate: true,
				reason: `output contained a single line of ${line.length} chars (limit ${MAX_LINE_CHARS})`,
			};
		}
	}

	// Sampled duplicate-window check. Evenly spaced start offsets across the
	// text; texts shorter than ~2 windows can't loop meaningfully and are
	// skipped (nearby offsets would overlap and self-match).
	if (text.length >= WINDOW_SIZE * 2) {
		const span = text.length - WINDOW_SIZE;
		const starts = new Set<number>();
		for (let i = 0; i < SAMPLE_COUNT; i++) {
			starts.add(Math.floor((i * span) / (SAMPLE_COUNT - 1)));
		}
		// Overlapping windows (start offsets closer than one window) can only be
		// equal when the text is periodic — which is exactly the loop signal —
		// but require enough distinct windows for the ratio to mean anything.
		if (starts.size >= MIN_WINDOWS_FOR_LOOP_CHECK) {
			const seen = new Map<string, number>();
			for (const start of starts) {
				const window = text.slice(start, start + WINDOW_SIZE);
				seen.set(window, (seen.get(window) ?? 0) + 1);
			}
			let duplicated = 0;
			for (const count of seen.values()) {
				if (count > 1) duplicated += count;
			}
			const ratio = duplicated / starts.size;
			if (ratio > DUPLICATE_RATIO_THRESHOLD) {
				return {
					degenerate: true,
					reason: `output appears to loop: ${Math.round(ratio * 100)}% of sampled ${WINDOW_SIZE}-char windows are duplicates`,
				};
			}
		}
	}

	return { degenerate: false };
}

export interface GuardedRewriteOptions {
	/** Hard bound on run() invocations. Default 2. Always terminates. */
	maxAttempts?: number;
	/**
	 * Extra domain check on a non-degenerate candidate. Return an error string
	 * (fed back to the next attempt) to reject, or null to accept.
	 */
	validate?: (text: string) => string | null;
}

/**
 * Bounded retry ladder around an LLM rewrite call.
 *
 * Each attempt's output is screened by detectDegenerateRewrite and the
 * optional `validate` hook. A rejection produces a feedback string handed to
 * the next attempt so the prompt can steer the model away from the failure.
 * After maxAttempts, returns the first non-degenerate candidate seen (one
 * that failed only `validate`), else null — never loops, never exceeds
 * maxAttempts calls.
 *
 * A null from run() means the transport itself declined (kill-switch,
 * timeout, provider error) — feedback can't fix that, so we stop immediately
 * rather than burn another full timeout, preserving the caller's existing
 * single-call latency envelope on transport failure.
 */
export async function guardedRewrite(
	run: (attempt: number, feedback?: string) => Promise<string | null>,
	opts: GuardedRewriteOptions = {},
): Promise<string | null> {
	const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 2));
	let feedback: string | undefined;
	let bestCandidate: string | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const output = await run(attempt, feedback);
		if (output === null) break; // transport-level failure — retry won't help

		const verdict = detectDegenerateRewrite(output);
		if (verdict.degenerate) {
			feedback = verdict.reason ?? "output was degenerate";
			continue;
		}

		const validationError = opts.validate ? opts.validate(output) : null;
		if (validationError === null) return output;

		// Non-degenerate but failed the domain check: usable as a last resort.
		if (bestCandidate === null) bestCandidate = output;
		feedback = validationError;
	}

	return bestCandidate;
}
