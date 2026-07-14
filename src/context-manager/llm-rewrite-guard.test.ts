import { describe, it, expect, vi } from "vitest";

import { detectDegenerateRewrite, guardedRewrite } from "./llm-rewrite-guard.js";

// Builds a distinct-looking paragraph of exactly `len` chars (no newlines).
function paragraphOf(len: number): string {
	let s = "";
	let i = 0;
	while (s.length < len) {
		s += `Fact ${i} about subsystem ${i * 7} and decision ${i * 13} in the campaign. `;
		i++;
	}
	return s.slice(0, len);
}

// Short-period single-line repetition — the token-loop failure mode.
const LOOPING_TEXT = "The summary loops here. ".repeat(200);

// Distinct numbered sentences — legitimately dense prose, must NOT flag.
const GOOD_LONG_TEXT = Array.from(
	{ length: 80 },
	(_, i) => `Sentence ${i} covers a distinct fact about subsystem ${i * 7} and decision ${i * 13}.`,
).join(" ");

describe("detectDegenerateRewrite", () => {
	it("flags empty and whitespace-only output", () => {
		expect(detectDegenerateRewrite("").degenerate).toBe(true);
		expect(detectDegenerateRewrite("   \n\t  \n").degenerate).toBe(true);
	});

	it("flags a single line over 10k chars", () => {
		const text = `DECISIONS:\n${"x".repeat(10_001)}\nCONSTRAINTS: none`;
		const verdict = detectDegenerateRewrite(text);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toMatch(/10000/);
	});

	it("flags short-period single-line loops", () => {
		const verdict = detectDegenerateRewrite(LOOPING_TEXT);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toMatch(/loop/i);
	});

	it("flags a 200-char paragraph repeated 40x — with and without newlines", () => {
		const para = paragraphOf(200);
		// Line-structured loop → duplicate-line branch.
		const asLines = detectDegenerateRewrite(Array.from({ length: 40 }, () => para).join("\n"));
		expect(asLines.degenerate).toBe(true);
		expect(asLines.reason).toMatch(/loop/i);
		// Single-line loop (8000 chars, under the 10k line cap) → compression branch.
		const asOneLine = detectDegenerateRewrite(para.repeat(40));
		expect(asOneLine.degenerate).toBe(true);
		expect(asOneLine.reason).toMatch(/loop/i);
	});

	it("flags a 270-char paragraph repeated 15x", () => {
		const verdict = detectDegenerateRewrite(paragraphOf(270).repeat(15));
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toMatch(/loop/i);
	});

	it("flags loops across a period sweep (50 / 200 / 400 char periods)", () => {
		expect(detectDegenerateRewrite(paragraphOf(50).repeat(30)).degenerate).toBe(true);
		expect(detectDegenerateRewrite(paragraphOf(200).repeat(20)).degenerate).toBe(true);
		expect(detectDegenerateRewrite(paragraphOf(400).repeat(10)).degenerate).toBe(true);
	});

	it("passes a realistic summary whose 30 bullets share a 22-char prefix", () => {
		const prefix = "- The user decided to ";
		const concerns = ["auth", "cache", "routing", "memory", "tools", "voice"];
		const bullets = Array.from(
			{ length: 30 },
			(_, i) =>
				`${prefix}adopt approach ${i} for module ${i * 3} covering ${concerns[i % 6]} concern number ${i * 11}.`,
		).join("\n");
		const text = `DECISIONS:\n${bullets}\n\nCONSTRAINTS:\n- do NOT use require() in ESM modules\n\nCURRENT_TASK_STATE: wiring the retry ladder into the summarizer.`;
		expect(detectDegenerateRewrite(text)).toEqual({ degenerate: false });
	});

	it("passes a sparse summary whose sections are mostly 'none'", () => {
		const text = [
			"DECISIONS:",
			"none",
			"",
			"CONSTRAINTS:",
			"none",
			"",
			"FACTS_ABOUT_USER:",
			"none",
			"",
			"OUTSTANDING_ASKS:",
			"none",
			"",
			"CURRENT_TASK_STATE: The agent is idle awaiting instructions from the user after a greeting exchange.",
		].join("\n");
		expect(detectDegenerateRewrite(text)).toEqual({ degenerate: false });
	});

	it("passes a summary that quotes the same 190-char constraint twice", () => {
		const constraint = paragraphOf(190);
		const text = `DECISIONS:\n- keep scope tight\n\nCONSTRAINTS:\n- ${constraint}\n\nCURRENT_TASK_STATE: Repeating the key constraint for emphasis: ${constraint}`;
		expect(detectDegenerateRewrite(text)).toEqual({ degenerate: false });
	});

	it("passes varied long single-paragraph text", () => {
		expect(detectDegenerateRewrite(GOOD_LONG_TEXT)).toEqual({ degenerate: false });
	});

	it("passes short text without tripping the loop checks", () => {
		expect(detectDegenerateRewrite("DECISIONS: use vitest.").degenerate).toBe(false);
	});

	it("is deterministic — same input, same verdict", () => {
		expect(detectDegenerateRewrite(LOOPING_TEXT)).toEqual(detectDegenerateRewrite(LOOPING_TEXT));
	});
});

describe("guardedRewrite", () => {
	it("returns a good first attempt without retrying", async () => {
		const run = vi.fn(async () => "A perfectly fine summary.");
		const result = await guardedRewrite(run);
		expect(result).toBe("A perfectly fine summary.");
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith(1, undefined);
	});

	it("retries a degenerate attempt with feedback describing the failure", async () => {
		const seenFeedback: (string | undefined)[] = [];
		const run = vi.fn(async (attempt: number, feedback?: string) => {
			seenFeedback.push(feedback);
			return attempt === 1 ? LOOPING_TEXT : "A corrected summary.";
		});
		const result = await guardedRewrite(run);
		expect(result).toBe("A corrected summary.");
		expect(run).toHaveBeenCalledTimes(2);
		expect(seenFeedback[0]).toBeUndefined();
		expect(seenFeedback[1]).toMatch(/loop/i);
	});

	it("never exceeds maxAttempts even when every attempt is degenerate", async () => {
		const run = vi.fn(async () => LOOPING_TEXT);
		const result = await guardedRewrite(run, { maxAttempts: 3 });
		expect(result).toBeNull();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("defaults to 2 attempts", async () => {
		const run = vi.fn(async () => "");
		const result = await guardedRewrite(run);
		expect(result).toBeNull();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("coerces non-finite maxAttempts to the default instead of running zero attempts", async () => {
		const run = vi.fn(async () => "A perfectly fine summary.");
		expect(await guardedRewrite(run, { maxAttempts: NaN })).toBe("A perfectly fine summary.");
		expect(run).toHaveBeenCalledTimes(1);
		const degenerateRun = vi.fn(async () => "");
		expect(await guardedRewrite(degenerateRun, { maxAttempts: Infinity })).toBeNull();
		expect(degenerateRun).toHaveBeenCalledTimes(2); // default bound, still terminates
	});

	it("treats a throwing validate hook as a rejection instead of propagating", async () => {
		const run = vi.fn(async () => "candidate text");
		const result = await guardedRewrite(run, {
			maxAttempts: 2,
			validate: () => {
				throw new Error("validator bug");
			},
		});
		// Never throws; the non-degenerate candidate is still the fallback.
		expect(result).toBe("candidate text");
		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenLastCalledWith(2, expect.stringContaining("validator bug"));
	});

	it("feeds validate rejections back and returns the best non-degenerate candidate", async () => {
		const seenFeedback: (string | undefined)[] = [];
		const run = vi.fn(async (attempt: number, feedback?: string) => {
			seenFeedback.push(feedback);
			return `candidate ${attempt}`;
		});
		const result = await guardedRewrite(run, {
			maxAttempts: 2,
			validate: () => "missing DECISIONS section",
		});
		// Both candidates failed validate but were non-degenerate; the first one
		// seen is returned as the fallback.
		expect(result).toBe("candidate 1");
		expect(run).toHaveBeenCalledTimes(2);
		expect(seenFeedback[1]).toBe("missing DECISIONS section");
	});

	it("accepts a later attempt that passes validate", async () => {
		const run = vi.fn(async (attempt: number) =>
			attempt === 1 ? "draft without sections" : "DECISIONS: final draft",
		);
		const result = await guardedRewrite(run, {
			maxAttempts: 2,
			validate: (text) => (text.startsWith("DECISIONS:") ? null : "must start with DECISIONS:"),
		});
		expect(result).toBe("DECISIONS: final draft");
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("stops immediately on a transport-level null (no wasted retry)", async () => {
		const run = vi.fn(async () => null);
		const result = await guardedRewrite(run, { maxAttempts: 3 });
		expect(result).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
