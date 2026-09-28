// GOLDEN characterization of the compaction trigger policy: the exact
// percentage bands at which each provider lane warns / compacts / force-
// compacts. Written BEFORE the policy consolidation (compaction-policy.ts)
// and kept green across it — any drift in a threshold value or lane mapping
// is a behavior change, not a refactor.
//
// The baselineTokens arg is used as a precise dial: with an empty message
// array the used-token count IS the baseline, so percentage = baseline / window
// exactly (window: claude-haiku-4-5 = 200k nominal, gpt-5.4-mini = 272k,
// grok-4.3 = 1M).
import { describe, it, expect } from "vitest";

import { getContextStatus } from "./status.js";

const at = (model: string, baseline: number) =>
	getContextStatus([], model, undefined, undefined, baseline);

describe("golden: Anthropic/default trigger bands (60 warn / 75 compact / 90 critical)", () => {
	it("59% → ok, nothing fires", () => {
		const s = at("claude-haiku-4-5",118_000);
		expect(s.percentage).toBe(59);
		expect(s).toMatchObject({ level: "ok", shouldCompact: false, forceCompact: false });
	});

	it("60% → warning only", () => {
		const s = at("claude-haiku-4-5",120_000);
		expect(s.percentage).toBe(60);
		expect(s).toMatchObject({ level: "warning", shouldCompact: false, forceCompact: false });
	});

	it("74% → still warning", () => {
		const s = at("claude-haiku-4-5",148_000);
		expect(s.percentage).toBe(74);
		expect(s.level).toBe("warning");
		expect(s.shouldCompact).toBe(false);
	});

	it("75% → compact (shouldCompact, not forced)", () => {
		const s = at("claude-haiku-4-5",150_000);
		expect(s.percentage).toBe(75);
		expect(s).toMatchObject({ level: "compact", shouldCompact: true, forceCompact: false });
	});

	it("90% → critical (forced)", () => {
		const s = at("claude-haiku-4-5",180_000);
		expect(s.percentage).toBe(90);
		expect(s).toMatchObject({ level: "critical", shouldCompact: true, forceCompact: true });
	});

	it("a non-Codex, non-Anthropic model (grok) uses the default bands", () => {
		// 75% of grok-4.3's 1M window.
		const s = at("grok-4.3", 750_000);
		expect(s.percentage).toBe(75);
		expect(s).toMatchObject({ level: "compact", shouldCompact: true, forceCompact: false });
	});
});

describe("golden: Codex trigger bands (25 warn / 35 compact / 55 critical)", () => {
	it("24% → ok", () => {
		const s = at("gpt-5.4-mini",65_280);
		expect(s.percentage).toBe(24);
		expect(s.level).toBe("ok");
	});

	it("25% → warning", () => {
		const s = at("gpt-5.4-mini",68_000);
		expect(s.percentage).toBe(25);
		expect(s).toMatchObject({ level: "warning", shouldCompact: false, forceCompact: false });
	});

	it("35% → compact", () => {
		const s = at("gpt-5.4-mini",95_200);
		expect(s.percentage).toBe(35);
		expect(s).toMatchObject({ level: "compact", shouldCompact: true, forceCompact: false });
	});

	it("55% → critical (forced)", () => {
		const s = at("gpt-5.4-mini",149_600);
		expect(s.percentage).toBe(55);
		expect(s).toMatchObject({ level: "critical", shouldCompact: true, forceCompact: true });
	});
});
