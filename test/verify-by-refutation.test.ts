import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub classify-with-llm so each voter's verdict is deterministic — no
// provider creds, no network. The mock dequeues one scripted return per call
// (in firing order) and records every call's args so the test can confirm
// per-voter prompt variation reached the classifier.
let __scriptedVotes: Array<boolean | null> = [];
const __calls: Array<{ category: string; systemPrompt: string; userPrompt: string }> = [];

vi.mock("../src/classifiers/classify-with-llm.js", () => ({
	classifyYesNo: vi.fn(async (args: { category: string; systemPrompt: string; userPrompt: string }) => {
		__calls.push({ category: args.category, systemPrompt: args.systemPrompt, userPrompt: args.userPrompt });
		// Pop the next scripted vote in call order; default null if exhausted.
		return __scriptedVotes.length > 0 ? __scriptedVotes.shift()! : null;
	}),
}));

const { verifyByRefutation } = await import("../src/classifiers/verify-by-refutation.js");

function script(votes: Array<boolean | null>) {
	__scriptedVotes = [...votes];
}

beforeEach(() => {
	__scriptedVotes = [];
	__calls.length = 0;
});

const BASE = {
	category: "test-refute",
	systemPrompt: "YES = you found a fatal flaw (refuted). NO = it holds up.",
	userPrompt: "Subject to scrutinize.",
};

describe("verifyByRefutation — tally + verdict", () => {
	it("(a) 3x true → refuted, refutedCount 3", async () => {
		script([true, true, true]);
		const v = await verifyByRefutation({ ...BASE });
		expect(v.verdict).toBe("refuted");
		expect(v.refutedCount).toBe(3);
		expect(v.holdsCount).toBe(0);
		expect(v.nullCount).toBe(0);
		expect(v.voters).toBe(3);
	});

	it("(b) 3x false → holds, holdsCount 3", async () => {
		script([false, false, false]);
		const v = await verifyByRefutation({ ...BASE });
		expect(v.verdict).toBe("holds");
		expect(v.holdsCount).toBe(3);
		expect(v.refutedCount).toBe(0);
		expect(v.nullCount).toBe(0);
		expect(v.voters).toBe(3);
	});

	it("(c) [true, true, false] → refuted (majority)", async () => {
		script([true, true, false]);
		const v = await verifyByRefutation({ ...BASE });
		expect(v.verdict).toBe("refuted");
		expect(v.refutedCount).toBe(2);
		expect(v.holdsCount).toBe(1);
		expect(v.nullCount).toBe(0);
	});

	it("(d) [true, false, null] → inconclusive (no majority)", async () => {
		script([true, false, null]);
		const v = await verifyByRefutation({ ...BASE });
		expect(v.verdict).toBe("inconclusive");
		expect(v.refutedCount).toBe(1);
		expect(v.holdsCount).toBe(1);
		expect(v.nullCount).toBe(1);
	});

	it("(e) 3x null → inconclusive, nullCount 3", async () => {
		script([null, null, null]);
		const v = await verifyByRefutation({ ...BASE });
		expect(v.verdict).toBe("inconclusive");
		expect(v.nullCount).toBe(3);
		expect(v.refutedCount).toBe(0);
		expect(v.holdsCount).toBe(0);
		expect(v.voters).toBe(3);
	});
});

describe("verifyByRefutation — lenses", () => {
	it("(f) lenses of length 4 → voters=4, threshold 3, distinct userPrompts", async () => {
		const lenses = [
			"security: can this exfiltrate data?",
			"correctness: does the logic actually hold?",
			"scope: does it overreach the request?",
			"reversibility: can the user undo this?",
		];
		// 3 refute, 1 holds → threshold is 3, so it's refuted (proves
		// threshold = floor(4/2)+1 = 3, not a bare 2-vote plurality).
		script([true, true, true, false]);
		const v = await verifyByRefutation({ ...BASE, lenses });
		expect(v.voters).toBe(4);
		expect(v.verdict).toBe("refuted");
		expect(v.refutedCount).toBe(3);
		expect(v.holdsCount).toBe(1);

		// Exactly 4 voters fired.
		expect(__calls).toHaveLength(4);
		// Each voter's userPrompt carries its distinct lens.
		for (let i = 0; i < lenses.length; i++) {
			expect(__calls[i].userPrompt).toContain(BASE.userPrompt);
			expect(__calls[i].userPrompt).toContain(lenses[i]);
			expect(__calls[i].userPrompt).toContain("Scrutinize specifically from this angle:");
		}
		// All four user prompts are distinct from one another.
		const uniquePrompts = new Set(__calls.map((c) => c.userPrompt));
		expect(uniquePrompts.size).toBe(4);
	});

	it("lenses below majority → holds (2 refute, 2 holds, threshold 3)", async () => {
		const lenses = ["angle-a", "angle-b", "angle-c", "angle-d"];
		script([true, true, false, false]);
		const v = await verifyByRefutation({ ...BASE, lenses });
		expect(v.voters).toBe(4);
		expect(v.verdict).toBe("inconclusive");
		expect(v.refutedCount).toBe(2);
		expect(v.holdsCount).toBe(2);
	});

	it("no lenses → all voters share the identical userPrompt", async () => {
		script([false, false, false]);
		await verifyByRefutation({ ...BASE });
		expect(__calls).toHaveLength(3);
		for (const c of __calls) {
			expect(c.userPrompt).toBe(BASE.userPrompt);
		}
	});

	it("custom voters count is honored when no lenses given", async () => {
		script([true, false, false, false, false]);
		const v = await verifyByRefutation({ ...BASE, voters: 5 });
		expect(v.voters).toBe(5);
		expect(__calls).toHaveLength(5);
		expect(v.verdict).toBe("holds"); // 4 holds >= threshold 3
	});
});
