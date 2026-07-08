import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { getContextStatus } from "./status.js";

// ~160k estimated tokens (chars/3.5): 16% of a 1M window (ok), 80% of a 200k
// window (compact). The gap is exactly the transport-aware behavior under test.
const bigConversation: ChatCompletionMessageParam[] = [
	{ role: "user", content: "a".repeat(560_000) },
];

describe("getContextStatus — transport-aware effective window", () => {
	it("omitting transport preserves the nominal 1M window for a 1M-rated model", () => {
		const s = getContextStatus(bigConversation, "claude-opus-4-8");
		expect(s.maxTokens).toBe(1_000_000);
		expect(s.percentage).toBe(16);
		expect(s.shouldCompact).toBe(false);
		expect(s.level).toBe("ok");
	});

	it("is byte-identical between omitted and explicit 'api' transport", () => {
		expect(getContextStatus(bigConversation, "claude-opus-4-8", undefined, "api"))
			.toEqual(getContextStatus(bigConversation, "claude-opus-4-8"));
	});

	// The core finding: the SAME conversation that never trips compaction on the
	// 1M-rated window crosses the 75% compact threshold on the CLI's ~200k window.
	it("compacts on the cli transport where it would not on the api transport", () => {
		const api = getContextStatus(bigConversation, "claude-opus-4-8", undefined, "api");
		expect(api.shouldCompact).toBe(false);

		const cli = getContextStatus(bigConversation, "claude-opus-4-8", undefined, "cli");
		expect(cli.maxTokens).toBe(200_000);
		expect(cli.percentage).toBe(80);
		expect(cli.shouldCompact).toBe(true);
		expect(cli.level).toBe("compact");
	});

	// Base-200k Anthropic models already size against 200k — transport is a no-op.
	it("is unchanged by transport for a base-200k Anthropic model", () => {
		const api = getContextStatus(bigConversation, "claude-sonnet-4-6", undefined, "api");
		const cli = getContextStatus(bigConversation, "claude-sonnet-4-6", undefined, "cli");
		expect(api.maxTokens).toBe(200_000);
		expect(cli).toEqual(api);
	});

	// Non-Anthropic providers never route through the Claude CLI proxy, so the
	// cli transport must not shrink their window.
	it("never shrinks a non-Anthropic window even on the cli transport", () => {
		const s = getContextStatus(bigConversation, "gpt-5.5", undefined, "cli");
		expect(s.maxTokens).toBe(1_000_000);
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
		const without = getContextStatus(smallConversation, "claude-opus-4-8", undefined, "cli");
		expect(without.shouldCompact).toBe(false);

		const withBaseline = getContextStatus(smallConversation, "claude-opus-4-8", undefined, "cli", 150_000);
		expect(withBaseline.usedTokens).toBe(without.usedTokens + 150_000);
		expect(withBaseline.percentage).toBe(77); // (4004 + 150k) / 200k
		expect(withBaseline.shouldCompact).toBe(true);
		expect(withBaseline.level).toBe("compact");
	});

	// A present anchor's token count ALREADY includes the baseline (it's the
	// provider's real input count), so the floor must be ignored there — else it
	// double-counts and over-compacts.
	it("ignores the baseline when a real-usage anchor is present (no double-count)", () => {
		const anchor = { anchorTokens: 120_000, estimateFrom: 1 };
		const withFloor = getContextStatus(smallConversation, "claude-opus-4-8", anchor, "cli", 150_000);
		const noFloor = getContextStatus(smallConversation, "claude-opus-4-8", anchor, "cli", 0);
		expect(withFloor).toEqual(noFloor);
		expect(withFloor.usedTokens).toBe(120_000); // anchor + 0 appended (estimateFrom past end)
	});

	// Omitted/0 baseline → byte-identical to the historical behavior.
	it("is byte-identical when the baseline is omitted", () => {
		expect(getContextStatus(smallConversation, "claude-opus-4-8", undefined, "cli", 0))
			.toEqual(getContextStatus(smallConversation, "claude-opus-4-8", undefined, "cli"));
	});
});
