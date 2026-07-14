/**
 * llm-rewrite-guard — deterministic validation for LLM rewrite/summarize
 * outputs, plus a bounded retry ladder.
 *
 * Motivation: a looping or otherwise degenerate model output (the classic
 * repeated-paragraph failure mode) is worse than no output at all — a
 * compaction summary made of the same paragraph repeated 40 times silently
 * replaces real history. detectDegenerateRewrite catches that class without
 * an LLM call; guardedRewrite gives the model one structured chance to fix
 * itself before the caller falls back to its null path (which, for the
 * compaction seam, feeds the existing circuit breaker in
 * canonical-loop/turn-loop/compact-history.ts).
 */

import { gzipSync } from "node:zlib";

const MAX_LINE_CHARS = 10_000;

// ── Duplicate-line check ────────────────────────────────────────────────────
// Loops that repeat whole lines/paragraphs produce many identical lines.
// Only "substantial" lines count: short lines like "none", "- yes", or bare
// section headers legitimately recur in a sparse sectioned summary and must
// not read as looping.
const SUBSTANTIAL_LINE_CHARS = 24;
const MIN_SUBSTANTIAL_LINES = 8;
const DUPLICATE_LINE_RATIO = 0.4;

// ── Compression-ratio check ─────────────────────────────────────────────────
// Period-robust loop signal: repetition at ANY period compresses to almost
// nothing. Calibrated 2026-07-13 against fixtures — genuinely looping text
// (24–400-char periods) gzips to 0.016–0.054 of its size; the tightest
// legitimate outputs measured are dense distinct-sentence prose at ~0.126 and
// a realistic 30-bullet shared-prefix summary at ~0.21. 0.10 sits ~2x above
// the worst loop and ~25% below the tightest real text. Short texts compress
// poorly (gzip header dominates), hence the length floor.
const COMPRESSION_MIN_CHARS = 400;
const COMPRESSION_RATIO_FLOOR = 0.1;

export interface DegenerateVerdict {
	degenerate: boolean;
	reason?: string;
}

/**
 * Deterministic degenerate-output detection. No LLM, no randomness — the same
 * text always yields the same verdict.
 *
 * Flags:
 *  - empty / whitespace-only output
 *  - any single line over 10k chars (runaway single-line generation)
 *  - looping output, via two period-robust signals:
 *      (a) >40% of substantial lines are duplicates of another line
 *      (b) gzip compression ratio below 0.10 for texts ≥400 chars
 *    (A sampled fixed-window comparison was tried first and rejected: window
 *    offsets almost never land congruent mod the loop period, so any loop
 *    with a period over ~40 chars — the motivating paragraph-scale failure —
 *    evaded it.)
 */
export function detectDegenerateRewrite(text: string): DegenerateVerdict {
	if (text.trim().length === 0) {
		return { degenerate: true, reason: "output was empty or whitespace-only" };
	}

	const lines = text.split("\n");
	for (const line of lines) {
		if (line.length > MAX_LINE_CHARS) {
			return {
				degenerate: true,
				reason: `output contained a single line of ${line.length} chars (limit ${MAX_LINE_CHARS})`,
			};
		}
	}

	// (a) Duplicate substantial lines — catches line/paragraph-structured loops.
	const substantial = lines
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length >= SUBSTANTIAL_LINE_CHARS);
	if (substantial.length >= MIN_SUBSTANTIAL_LINES) {
		const counts = new Map<string, number>();
		for (const line of substantial) counts.set(line, (counts.get(line) ?? 0) + 1);
		let duplicated = 0;
		for (const count of counts.values()) {
			if (count > 1) duplicated += count;
		}
		const ratio = duplicated / substantial.length;
		if (ratio > DUPLICATE_LINE_RATIO) {
			return {
				degenerate: true,
				reason: `output appears to loop: ${Math.round(ratio * 100)}% of its lines are duplicates`,
			};
		}
	}

	// (b) Compression ratio — catches loops of ANY period, including single-line
	// repetition the line check can't see.
	if (text.length >= COMPRESSION_MIN_CHARS) {
		const ratio = gzipSync(Buffer.from(text)).length / Buffer.byteLength(text);
		if (ratio < COMPRESSION_RATIO_FLOOR) {
			return {
				degenerate: true,
				reason: `output appears to loop: it compresses to ${Math.round(ratio * 100)}% of its size (highly repetitive)`,
			};
		}
	}

	return { degenerate: false };
}

export interface GuardedRewriteOptions {
	/** Hard bound on run() invocations. Default 2 (also for non-finite values). Always terminates. */
	maxAttempts?: number;
	/**
	 * Extra domain check on a non-degenerate candidate. Return an error string
	 * (fed back to the next attempt) to reject, or null to accept. A throwing
	 * hook is treated as a rejection, never propagated.
	 */
	validate?: (text: string) => string | null;
}

const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Bounded retry ladder around an LLM rewrite call.
 *
 * Each attempt's output is screened by detectDegenerateRewrite and the
 * optional `validate` hook. A rejection produces a feedback string handed to
 * the next attempt so the prompt can steer the model away from the failure.
 * After maxAttempts, returns the first non-degenerate candidate seen (one
 * that failed only `validate`), else null — never loops, never exceeds
 * maxAttempts calls, and never throws from a rejecting validate hook.
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
	const requested = opts.maxAttempts;
	const maxAttempts =
		typeof requested === "number" && Number.isFinite(requested)
			? Math.max(1, Math.floor(requested))
			: DEFAULT_MAX_ATTEMPTS;
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

		let validationError: string | null;
		try {
			validationError = opts.validate ? opts.validate(output) : null;
		} catch (e) {
			// A buggy validate hook must not turn the whole rewrite into a throw —
			// treat it as a rejection of this candidate.
			validationError = `validation failed: ${(e as Error).message}`;
		}
		if (validationError === null) return output;

		// Non-degenerate but failed the domain check: usable as a last resort.
		if (bestCandidate === null) bestCandidate = output;
		feedback = validationError;
	}

	return bestCandidate;
}
