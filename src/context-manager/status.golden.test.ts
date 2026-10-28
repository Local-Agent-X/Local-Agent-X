// GOLDEN characterization of the compaction trigger policy: the exact
// percentage bands at which the context warns / compacts / force-compacts.
// They all derive from the user's "Compact at" (compactAtPercent, default 90):
// warning 15 points before, forced 5 points after (never past 97). Every lane
// reads the same setting — the old early Codex bands (25/35/55) were dropped
// after the 2026-10-26 long-context eval (compaction-policy.ts).
//
// The baselineTokens arg is used as a precise dial: with an empty message
// array the used-token count IS the baseline, so percentage = baseline / budget,
// the budget being the window less the 1,024-token reply reserve (status.ts;
// window: claude-haiku-4-5 = 200k nominal, gpt-5.4-mini = 272k, grok-4.3 = 1M).
// Each dial below is a round share of the window and rounds to the same
// percentage of the budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getContextStatus } from "./status.js";
import { compactAtPercent, conversationBudgetShare } from "./compaction-policy.js";
import { reloadSettings, saveSettings } from "../settings.js";
import { settingSpec, BROADCAST_KEYS } from "../settings-schema.js";

const at = (model: string, baseline: number) =>
	getContextStatus([], model, undefined, undefined, baseline);

let dir: string;
let prevEnv: string | undefined;
beforeEach(() => {
	prevEnv = process.env.LAX_DATA_DIR;
	dir = mkdtempSync(join(tmpdir(), "lax-compact-at-"));
	process.env.LAX_DATA_DIR = dir;
	reloadSettings();
});
afterEach(() => {
	if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = prevEnv;
	rmSync(dir, { recursive: true, force: true });
	reloadSettings();
});

describe("golden: default bands (75 warn / 90 compact / 95 critical)", () => {
	it("74% → ok, nothing fires", () => {
		const s = at("claude-haiku-4-5", 148_000);
		expect(s.percentage).toBe(74);
		expect(s).toMatchObject({ level: "ok", shouldCompact: false, forceCompact: false });
	});

	it("75% → warning only", () => {
		const s = at("claude-haiku-4-5", 150_000);
		expect(s.percentage).toBe(75);
		expect(s).toMatchObject({ level: "warning", shouldCompact: false, forceCompact: false });
	});

	it("89% → still warning", () => {
		const s = at("claude-haiku-4-5", 178_000);
		expect(s.percentage).toBe(89);
		expect(s.level).toBe("warning");
		expect(s.shouldCompact).toBe(false);
	});

	it("90% → compact (shouldCompact, not forced)", () => {
		const s = at("claude-haiku-4-5", 180_000);
		expect(s.percentage).toBe(90);
		expect(s).toMatchObject({ level: "compact", shouldCompact: true, forceCompact: false });
	});

	it("95% → critical (forced)", () => {
		const s = at("claude-haiku-4-5", 190_000);
		expect(s.percentage).toBe(95);
		expect(s).toMatchObject({ level: "critical", shouldCompact: true, forceCompact: true });
	});

	it("a Codex model reads the same bands — 35% no longer compacts it", () => {
		expect(at("gpt-5.4-mini", 95_200)).toMatchObject({ percentage: 35, level: "ok", shouldCompact: false });
		expect(at("gpt-5.4-mini", 244_800)).toMatchObject({ percentage: 90, level: "compact", shouldCompact: true });
	});

	it("a non-Codex, non-Anthropic model (grok) reads the same bands", () => {
		expect(at("grok-4.3", 900_000)).toMatchObject({ percentage: 90, level: "compact", shouldCompact: true });
	});

	it("between messages the conversation is folded at the warning line", () => {
		expect(conversationBudgetShare()).toBe(0.75);
	});
});

describe("golden: the user's \"Compact at\" moves every band", () => {
	it("compactAtPercent 70 → 55 warn / 70 compact / 75 critical, checkpoint at 55%", () => {
		saveSettings({ compactAtPercent: 70 });
		expect(compactAtPercent()).toBe(70);
		expect(at("claude-haiku-4-5", 110_000)).toMatchObject({ percentage: 55, level: "warning" });
		expect(at("claude-haiku-4-5", 140_000)).toMatchObject({ percentage: 70, level: "compact", forceCompact: false });
		expect(at("claude-haiku-4-5", 150_000)).toMatchObject({ percentage: 75, level: "critical", forceCompact: true });
		expect(conversationBudgetShare()).toBe(0.55);
	});

	it("compactAtPercent 95 forces at 97, never past it", () => {
		saveSettings({ compactAtPercent: 95 });
		expect(at("claude-haiku-4-5", 192_000)).toMatchObject({ percentage: 96, level: "compact", forceCompact: false });
		expect(at("claude-haiku-4-5", 194_000)).toMatchObject({ percentage: 97, level: "critical", forceCompact: true });
	});

	it("an out-of-range or non-numeric value is ignored and the default holds", () => {
		for (const v of [99, 10, "80", null]) {
			saveSettings({ compactAtPercent: v });
			expect(compactAtPercent()).toBe(90);
		}
	});
});

describe("the \"Compact at\" setting's schema entry", () => {
	it("accepts the policy's range, rejects outside it, and broadcasts a change to open tabs", () => {
		const spec = settingSpec("compactAtPercent");
		expect(spec?.owner).toBe("agent");
		for (const ok of [50, 80, 90, 95]) expect(spec?.validate.safeParse(ok).success).toBe(true);
		for (const bad of [49, 96, 99, 80.5, "80"]) expect(spec?.validate.safeParse(bad).success).toBe(false);
		expect(BROADCAST_KEYS.has("compactAtPercent")).toBe(true);
	});
});
