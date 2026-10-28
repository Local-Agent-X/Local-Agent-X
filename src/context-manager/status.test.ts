import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { getContextStatus } from "./status.js";
import { OUTPUT_RESERVE_TOKENS } from "./request-fit.js";

// maxTokens is the request budget: the window less the reply's reserve (the
// flat 1,024 for every model here), the same budget preflight refuses against.
const budget = (window: number) => window - OUTPUT_RESERVE_TOKENS;

// ~160k estimated tokens (chars/3.5): 16% of a 1M window (ok), 80% of a 200k
// window (compact). The gap is exactly the transport-aware behavior under test.
const bigConversation: ChatCompletionMessageParam[] = [
	{ role: "user", content: "a".repeat(560_000) },
];

// claude-opus-4-7: 1M nominal, and no measured subscription window, so the
// subscription lane sizes it at the 200k fallback.
describe("getContextStatus — transport-aware effective window", () => {
	it("omitting transport preserves the nominal 1M window for a 1M-rated model", () => {
		const s = getContextStatus(bigConversation, "claude-opus-4-7");
		expect(s.maxTokens).toBe(budget(1_000_000));
		expect(s.percentage).toBe(16);
		expect(s.shouldCompact).toBe(false);
		expect(s.level).toBe("ok");
	});

	it("is byte-identical between omitted and explicit 'api' transport", () => {
		expect(getContextStatus(bigConversation, "claude-opus-4-7", undefined, "api"))
			.toEqual(getContextStatus(bigConversation, "claude-opus-4-7"));
	});

	// The core finding: the SAME conversation that sits low on the 1M-rated
	// window is near the top of the subscription lane's 200k fallback window.
	it("sizes against the cli transport's smaller window where the api transport would not", () => {
		const api = getContextStatus(bigConversation, "claude-opus-4-7", undefined, "api");
		expect(api.level).toBe("ok");

		const cli = getContextStatus(bigConversation, "claude-opus-4-7", undefined, "cli");
		expect(cli.maxTokens).toBe(budget(200_000));
		expect(cli.percentage).toBe(80);
		expect(cli.level).toBe("warning");
	});

	// A model the subscription lane has been measured on sizes against what it
	// served (opus-4-8: 276k), not the fallback — and still not the nominal 1M.
	it("sizes a measured model on the cli transport by its proven subscription window", () => {
		const cli = getContextStatus(bigConversation, "claude-opus-4-8", undefined, "cli");
		expect(cli.maxTokens).toBe(budget(276_000));
		expect(cli.percentage).toBe(58);
		expect(cli.shouldCompact).toBe(false);
		expect(getContextStatus(bigConversation, "claude-opus-4-8", undefined, "api").maxTokens).toBe(budget(1_000_000));
	});

	// Base-200k Anthropic models already size against 200k — transport is a no-op.
	it("is unchanged by transport for a base-200k Anthropic model", () => {
		const api = getContextStatus(bigConversation, "claude-haiku-4-5", undefined, "api");
		const cli = getContextStatus(bigConversation, "claude-haiku-4-5", undefined, "cli");
		expect(api.maxTokens).toBe(budget(200_000));
		expect(cli).toEqual(api);
	});

	// Non-Anthropic providers are never on the Claude subscription lane, so the
	// cli transport must not shrink their window.
	it("never shrinks a non-Anthropic window even on the cli transport", () => {
		const s = getContextStatus(bigConversation, "gpt-5.5", undefined, "cli");
		expect(s.maxTokens).toBe(budget(1_050_000));
	});
});

describe("getContextStatus — baseline floor", () => {
	// A tiny conversation the estimate reads as ~0% — but the real request also
	// carries a ~150k baseline (system prompt + tool manifest) the estimate can't
	// see. Feeding it in flips the sizing from "ok" to "critical" on the 200k
	// CLI window, which is the whole point: compaction can fire before the real
	// request overruns instead of dying on a raw "prompt too long".
	const smallConversation: ChatCompletionMessageParam[] = [
		{ role: "user", content: "b".repeat(14_000) }, // ~4k tokens
	];

	it("adds the baseline to the estimate on the pure-estimate branch", () => {
		const without = getContextStatus(smallConversation, "claude-opus-4-7", undefined, "cli");
		expect(without.shouldCompact).toBe(false);

		const withBaseline = getContextStatus(smallConversation, "claude-opus-4-7", undefined, "cli", 180_000);
		expect(withBaseline.usedTokens).toBe(without.usedTokens + 180_000);
		expect(withBaseline.percentage).toBe(92); // (4004 + 180k) / 200k
		expect(withBaseline.shouldCompact).toBe(true);
		expect(withBaseline.level).toBe("compact");
	});

	// A present anchor's token count ALREADY includes the baseline (it's the
	// provider's real input count), so the floor must be ignored there — else it
	// double-counts and over-compacts.
	it("ignores the baseline when a real-usage anchor is present (no double-count)", () => {
		const anchor = { anchorTokens: 120_000, estimateFrom: 1 };
		const withFloor = getContextStatus(smallConversation, "claude-opus-4-7", anchor, "cli", 150_000);
		const noFloor = getContextStatus(smallConversation, "claude-opus-4-7", anchor, "cli", 0);
		expect(withFloor).toEqual(noFloor);
		expect(withFloor.usedTokens).toBe(120_000); // anchor + 0 appended (estimateFrom past end)
	});

	// Omitted/0 baseline → byte-identical to the historical behavior.
	it("is byte-identical when the baseline is omitted", () => {
		expect(getContextStatus(smallConversation, "claude-opus-4-7", undefined, "cli", 0))
			.toEqual(getContextStatus(smallConversation, "claude-opus-4-7", undefined, "cli"));
	});
});
