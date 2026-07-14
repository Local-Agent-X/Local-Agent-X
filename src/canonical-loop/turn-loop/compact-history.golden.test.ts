// GOLDEN characterization of the turn-loop compaction POLICY through the real
// context-manager sizing (getContextStatus is NOT mocked here, unlike
// compact-history.test.ts): the exact fullness bands that pick how many
// trailing messages survive verbatim (6 / 4 at ≥95% / 2 at forced-or-≥99%).
// Written BEFORE the policy consolidation (context-manager/compaction-policy.ts)
// and kept green across it — same inputs must keep producing the same trigger
// decisions and the same surviving rows.
//
// baselineTokens is the fullness dial: 12 tiny messages estimate to exactly 60
// tokens, so percentage = (baseline + 60) / 200_000 on claude-sonnet-4-6.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));
// Pin the transport so sizing never depends on this box's saved credentials.
vi.mock("../../context-manager/resolve-transport.js", () => ({ resolveAnthropicTransport: () => "cli" }));

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { compactHistory, forceCompactNext } from "./compact-history.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockSummarize = vi.mocked(summarizeOldMessages);

const u = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
const a = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });

// 12 rows, 5 estimated tokens each (4 role overhead + ceil(2/3.5)) → 60 total.
const history = (): CanonicalMessage[] => [
	u("u1", "q1"), a("a1", "r1"), u("u2", "q2"), a("a2", "r2"),
	u("u3", "q3"), a("a3", "r3"), u("u4", "q4"), a("a4", "r4"),
	u("u5", "q5"), a("a5", "r5"), u("u6", "q6"), a("a6", "r6"),
];

const MODEL = "claude-sonnet-4-6"; // 200k window on either transport

// baseline that lands the estimate on an exact percentage of the 200k window.
const pct = (p: number) => (p / 100) * 200_000 - 60;

const ids = (msgs: CanonicalMessage[]) => msgs.map((m) => m.messageId);

beforeEach(() => {
	mockSummarize.mockReset();
	mockSummarize.mockResolvedValue("GOLDEN SUMMARY");
});

describe("golden: turn-loop keep-last policy bands", () => {
	it("74% → under the compact trigger, structural no-op", async () => {
		const msgs = history();
		const out = await compactHistory(msgs, MODEL, null, undefined, pct(74));
		expect(out.compacted).toBe(false);
		expect(out.messages).toBe(msgs);
		expect(mockSummarize).not.toHaveBeenCalled();
	});

	it("75% → compacts keeping the last 6 rows (summary folds into u4)", async () => {
		const out = await compactHistory(history(), MODEL, null, undefined, pct(75));
		expect(out.compacted).toBe(true);
		expect(ids(out.messages)).toEqual(["u4", "a4", "u5", "a5", "u6", "a6"]);
		const folded = (out.messages[0].content as { text: string }).text;
		expect(folded).toContain("[Earlier conversation auto-summarized to save context — 6 messages, range u1:a3]");
		expect(folded).toContain("GOLDEN SUMMARY");
		expect(folded).toContain("q4"); // anchor row's own text survives the fold
	});

	it("94% → still the default keep of 6", async () => {
		const out = await compactHistory(history(), MODEL, null, undefined, pct(94));
		expect(ids(out.messages)).toEqual(["u4", "a4", "u5", "a5", "u6", "a6"]);
	});

	it("95% → keep tightens to 4 (tail from u5)", async () => {
		const out = await compactHistory(history(), MODEL, null, undefined, pct(95));
		expect(ids(out.messages)).toEqual(["u5", "a5", "u6", "a6"]);
		expect((out.messages[0].content as { text: string }).text)
			.toContain("auto-summarized to save context — 8 messages");
	});

	it("98% → still 4", async () => {
		const out = await compactHistory(history(), MODEL, null, undefined, pct(98));
		expect(ids(out.messages)).toEqual(["u5", "a5", "u6", "a6"]);
	});

	it("99% → aggressive keep of 2 (tail from u6)", async () => {
		const out = await compactHistory(history(), MODEL, null, undefined, pct(99));
		expect(ids(out.messages)).toEqual(["u6", "a6"]);
		expect((out.messages[0].content as { text: string }).text)
			.toContain("auto-summarized to save context — 10 messages");
	});

	it("forced (provider overflow) at 50% → compacts anyway with the aggressive keep of 2", async () => {
		forceCompactNext("golden-forced");
		const out = await compactHistory(history(), MODEL, null, "golden-forced", pct(50));
		expect(out.compacted).toBe(true);
		expect(ids(out.messages)).toEqual(["u6", "a6"]);
	});
});
