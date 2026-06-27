/**
 * verifyByRefutation — generic "verify by refutation" for high-stakes outputs.
 *
 * Pattern: instead of asking one model "is this safe?", fire N INDEPENDENT
 * skeptics, each prompted to REFUTE a claim/action — to actively hunt for a
 * fatal flaw. A strict-majority refutation means the subject is probably
 * unsafe/wrong; a strict-majority "holds" means it survived scrutiny. Anything
 * short of a majority is "inconclusive" (commonly: every voter was unavailable,
 * so the LLM couldn't weigh in at all).
 *
 * Each voter is a `classifyYesNo` call (so all provider routing, background-
 * model selection, timeout, and null-fallback are inherited from
 * `classify-with-llm.ts` — this helper does NOT touch any of that). The YES/NO
 * convention is DELIBERATELY refutation-shaped:
 *   - YES = the voter found a fatal flaw → it REFUTES the subject.
 *   - NO  = the subject holds up under that voter's scrutiny.
 *   - null = that voter was unavailable / unparseable (does not count either
 *     way).
 *
 * This helper is POLICY-FREE: it only tallies votes and reports a verdict. The
 * CALLER picks the fail-safe direction, because that differs per use site —
 * e.g. a self-edit gate may treat "inconclusive" as block (no proof it's
 * safe), while an egress check may treat the same verdict as allow. Keeping the
 * fail-safe decision out of here lets one tally serve both.
 *
 * Independence comes from either sampling variance (all voters see the same
 * prompt) or distinct `lenses` (one scrutiny angle per voter, appended to the
 * user prompt).
 */

import { classifyYesNo } from "./classify-with-llm.js";

const DEFAULT_VOTERS = 3;
const DEFAULT_TIMEOUT_MS = 4000;

export interface RefutationVerdict {
	verdict: "refuted" | "holds" | "inconclusive";
	refutedCount: number;   // voters that said YES (could refute / found a fatal flaw)
	holdsCount: number;     // voters that said NO (it holds up)
	nullCount: number;      // voters that were unavailable/unparseable
	voters: number;         // total voters attempted
}

export async function verifyByRefutation(args: {
	category: string;            // telemetry/env-disable label, e.g. "self-edit-refute"
	systemPrompt: string;        // describes what would make the subject UNSAFE/WRONG; MUST instruct: YES = you found a fatal flaw (refuted), NO = it holds up
	userPrompt: string;          // the subject + context to scrutinize
	voters?: number;             // default 3
	lenses?: string[];           // optional: one distinct angle per voter (appended to userPrompt). If provided, voters = lenses.length
	timeoutMs?: number;          // passed through to each classifyYesNo (default 4000)
	model?: string;
	envDisableVar?: string;
	signal?: AbortSignal;
}): Promise<RefutationVerdict> {
	// Voter count: an explicit lens list pins it (one voter per angle);
	// otherwise the requested count, defaulting to 3.
	const n = args.lenses?.length ? args.lenses.length : (args.voters ?? DEFAULT_VOTERS);
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// One prompt per voter. With lenses, append the per-voter scrutiny angle so
	// each skeptic attacks from a different direction; without, all voters share
	// the same prompt and independence comes from sampling variance.
	const prompts: string[] = [];
	for (let i = 0; i < n; i++) {
		const lens = args.lenses?.[i];
		prompts.push(
			lens
				? `${args.userPrompt}\n\nScrutinize specifically from this angle: ${lens}`
				: args.userPrompt,
		);
	}

	// Fire all voters in parallel. classifyYesNo never throws (it swallows its
	// own provider/timeout errors and resolves null), so Promise.all won't
	// reject under normal operation — we keep the tally defensive without
	// hiding real bugs.
	const votes = await Promise.all(
		prompts.map((userPrompt) =>
			classifyYesNo({
				category: args.category,
				systemPrompt: args.systemPrompt,
				userPrompt,
				timeoutMs,
				model: args.model,
				envDisableVar: args.envDisableVar,
				signal: args.signal,
			}),
		),
	);

	let refutedCount = 0;
	let holdsCount = 0;
	let nullCount = 0;
	for (const vote of votes) {
		if (vote === true) refutedCount++;
		else if (vote === false) holdsCount++;
		else nullCount++;
	}

	// Strict majority of attempted voters. With n=3 → threshold 2; n=4 → 3.
	const threshold = Math.floor(n / 2) + 1;
	let verdict: RefutationVerdict["verdict"];
	if (refutedCount >= threshold) verdict = "refuted";
	else if (holdsCount >= threshold) verdict = "holds";
	else verdict = "inconclusive";

	return { verdict, refutedCount, holdsCount, nullCount, voters: n };
}
