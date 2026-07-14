import { describe, it, expect, vi } from "vitest";

import { detectDegenerateRewrite, guardedRewrite } from "./llm-rewrite-guard.js";

// A short-period repeated sentence: with 50 evenly spaced 200-char windows
// over a 24-char-period text, the pigeonhole principle guarantees well over
// 40% of windows share a phase (and therefore content) with another window.
const LOOPING_TEXT = "The summary loops here. ".repeat(200);

// Distinct numbered sentences — no two 200-char windows can match.
const GOOD_LONG_TEXT = Array.from(
	{ length: 80 },
	(_, i) => `Sentence ${i} covers a distinct fact about subsystem ${i * 7} and decision ${i * 13}.`,
).join(" ");

describe("detectDegenerateRewrite", () => {
	it("flags empty and whitespace-only output", () => {
		expect(detectDegenerateRewrite("").degenerate).toBe(true);
		expect(detectDegenerateRewrite("   \n\t  \n").degenerate).toBe(true);
	});

	it("flags looping output via sampled duplicate windows", () => {
		const verdict = detectDegenerateRewrite(LOOPING_TEXT);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toMatch(/loop/i);
	});

	it("flags a single line over 10k chars", () => {
		const text = `DECISIONS:\n${"x".repeat(10_001)}\nCONSTRAINTS: none`;
		const verdict = detectDegenerateRewrite(text);
		expect(verdict.degenerate).toBe(true);
		expect(verdict.reason).toMatch(/10000/);
	});

	it("passes varied long text", () => {
		expect(detectDegenerateRewrite(GOOD_LONG_TEXT)).toEqual({ degenerate: false });
	});

	it("passes short text without tripping the window check", () => {
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
