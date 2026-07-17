// Control-marker invariant regression suite.
//
// Class of bug: control-plane facts ("this turn was interrupted", "these
// tools ran") written as inline text into model-visible assistant content.
// The model reads them as language and imitates them — the voice
// " [interrupted by user]" marker was echoed by Grok into a single assistant
// message containing 763 copies (session chat-mrog3e98-2uva8, 2026-07-17).
// providers/sanitize.ts is the one seam every provider-bound history crosses
// (buildCleanHistory → sanitizeHistory); these tests pin its guarantees:
//  - `_interrupted: true` metadata renders as the canonical boundary sentence
//  - legacy/echoed marker text is scrubbed, so polluted sessions self-heal
//  - no assistant content reaching a provider ever matches a retired marker
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { sanitizeHistory, buildCleanHistory, INTERRUPTED_TURN_BOUNDARY } from "./sanitize.js";

const u = (text: string): ChatCompletionMessageParam => ({ role: "user", content: text });
const a = (text: string, extra?: Record<string, unknown>): ChatCompletionMessageParam =>
	({ role: "assistant", content: text, ...extra }) as ChatCompletionMessageParam;

const contentOf = (m: ChatCompletionMessageParam): string => m.content as string;

describe("control-marker invariant at the provider seam", () => {
	it("renders _interrupted metadata as the canonical boundary and strips the flag", () => {
		const out = sanitizeHistory([u("hey"), a("partial reply", { _interrupted: true })]);
		expect(out).toHaveLength(2);
		expect(contentOf(out[1])).toBe(`partial reply\n\n${INTERRUPTED_TURN_BOUNDARY}`);
		expect((out[1] as unknown as Record<string, unknown>)._interrupted).toBeUndefined();
	});

	it("renders an interrupted-before-speaking turn as the bare boundary", () => {
		const out = sanitizeHistory([u("hey"), a("[no reply]", { _interrupted: true })]);
		expect(contentOf(out[1])).toBe(`[no reply]\n\n${INTERRUPTED_TURN_BOUNDARY}`);
	});

	it("scrubs the legacy inline interrupt marker and re-renders it canonically", () => {
		const out = sanitizeHistory([u("hey"), a("Here's the status. Want me to trim it tighter? [interrupted by user]")]);
		expect(contentOf(out[1])).toBe(`Here's the status. Want me to trim it tighter?\n\n${INTERRUPTED_TURN_BOUNDARY}`);
	});

	it("heals the real-world 763-repeat spam, including a model-mangled unclosed copy", () => {
		// Shape taken from the polluted session: speech, then hundreds of
		// echoed markers, one of them missing its closing bracket.
		const spam = "Yeah, fair. The source was noisy." +
			" [interrupted by user]".repeat(400) +
			" [interrupted by user" +
			" [interrupted by user]".repeat(362);
		const out = sanitizeHistory([u("hey"), a(spam)]);
		expect(contentOf(out[1])).toBe(`Yeah, fair. The source was noisy.\n\n${INTERRUPTED_TURN_BOUNDARY}`);
	});

	it("collapses a marker-only assistant message to the bare boundary", () => {
		const out = sanitizeHistory([u("hey"), a("[interrupted by user]")]);
		expect(contentOf(out[1])).toBe(INTERRUPTED_TURN_BOUNDARY);
	});

	it("keeps the chat path's deliberate standalone boundary row verbatim", () => {
		const out = sanitizeHistory([u("hey"), a(INTERRUPTED_TURN_BOUNDARY, { _interrupted: true })]);
		expect(contentOf(out[1])).toBe(INTERRUPTED_TURN_BOUNDARY);
		expect((out[1] as unknown as Record<string, unknown>)._interrupted).toBeUndefined();
	});

	it("removes model echoes of the boundary embedded in speech without flagging interruption", () => {
		const out = sanitizeHistory([u("hey"), a(`Sure. ${INTERRUPTED_TURN_BOUNDARY} As I was saying, done.`)]);
		expect(contentOf(out[1])).toBe("Sure.  As I was saying, done.");
		expect(contentOf(out[1])).not.toContain(INTERRUPTED_TURN_BOUNDARY);
	});

	it("scrubs the retired tool-trace marker WITHOUT rendering an interruption", () => {
		const out = sanitizeHistory([u("hey"), a("Done. [Tool calls this turn: web_search, speak]")]);
		expect(contentOf(out[1])).toBe("Done.");
	});

	it("leaves clean assistant speech untouched (same object, no copy)", () => {
		const msg = a("Brackets in speech are fine [citation needed] and stay.");
		const out = sanitizeHistory([u("hey"), msg]);
		expect(out[1]).toBe(msg);
	});

	it("class guard: no retired marker survives to provider-bound history", () => {
		// Seeded with every known offender; if a third marker is ever invented,
		// add it to CONTROL_MARKERS in sanitize.ts and to this fixture — then
		// delete its writer, because writing one is the actual bug.
		const polluted: ChatCompletionMessageParam[] = [
			u("q1"), a("r1 [interrupted by user]"),
			u("q2"), a("[interrupted by user] ".repeat(50)),
			u("q3"), a("r3 [Tool calls this turn: none]"),
			u("q4"), a("r4", { _interrupted: true }),
		];
		const out = buildCleanHistory(polluted, "web");
		for (const m of out) {
			if (m.role !== "assistant" || typeof m.content !== "string") continue;
			expect(m.content).not.toMatch(/\[interrupted by user/);
			expect(m.content).not.toMatch(/\[Tool calls this turn:/);
			// Boundary may appear exactly once per message, only as the canonical rendering.
			const echoes = m.content.split(INTERRUPTED_TURN_BOUNDARY).length - 1;
			expect(echoes).toBeLessThanOrEqual(1);
		}
	});
});
