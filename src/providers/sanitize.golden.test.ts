// GOLDEN characterization of the chat-lane truncation + digest POLICY: the
// exact keep counts per channel (40 web / 30 otherwise), the deterministic
// digest's clip boundaries (user 2000 head + 1000 tail, assistant 300,
// tool 200) and its 24k total char budget. Written BEFORE the policy
// consolidation (context-manager/compaction-policy.ts) and kept green across
// it — same inputs must keep producing byte-identical digests and the same
// keep decisions. (The background LLM-summary layer is exercised in
// test/truncate-history-preserves-constraints.test.ts; under VITEST the
// refresh scheduler is inert, so these tests see only the deterministic path.)
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import {
	buildCleanHistory,
	truncateHistory,
	sanitizeHistory,
	renderTurnErrorBoundary,
	TURN_ERROR_BOUNDARY_HEAD,
} from "./sanitize.js";

const u = (text: string): ChatCompletionMessageParam => ({ role: "user", content: text });
const a = (text: string): ChatCompletionMessageParam => ({ role: "assistant", content: text });

// n alternating user/assistant rows, user first (even indices are user).
function alternating(n: number): ChatCompletionMessageParam[] {
	const out: ChatCompletionMessageParam[] = [];
	for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? u(`ask ${i}`) : a(`reply ${i}`));
	return out;
}

const summaryOf = (msgs: ChatCompletionMessageParam[]): string => {
	expect(msgs[0].role).toBe("system");
	return msgs[0].content as string;
};

describe("golden: chat-lane keep counts", () => {
	it("web channel keeps the last 40 rows (10 digested)", () => {
		const out = buildCleanHistory(alternating(50), "web");
		expect(out).toHaveLength(41); // digest row + 40 kept
		expect(summaryOf(out)).toContain('<prior_conversation count="10">');
		expect(out[1].content).toBe("ask 10"); // cut lands on the user row at idx 10
	});

	it("non-web channels keep the last 30 rows (20 digested)", () => {
		const out = buildCleanHistory(alternating(50), "cli");
		expect(out).toHaveLength(31);
		expect(summaryOf(out)).toContain('<prior_conversation count="20">');
		expect(out[1].content).toBe("ask 20");
	});

	it("an explicit maxHistory overrides the channel default", () => {
		const out = buildCleanHistory(alternating(50), "web", 10);
		expect(out).toHaveLength(11);
		expect(summaryOf(out)).toContain('<prior_conversation count="40">');
	});

	it("truncateHistory defaults to a keep of 30", () => {
		const out = truncateHistory(alternating(50));
		expect(out).toHaveLength(31);
	});

	it("under the keep there is no digest row at all", () => {
		const msgs = alternating(30);
		expect(truncateHistory(msgs, 30)).toEqual(msgs);
	});
});

describe("golden: deterministic digest clip boundaries", () => {
	// Tail of 4 rows starting on a user row so the cut lands exactly there and
	// `old` is precisely the rows before it.
	const tail = [u("recent ask"), a("recent reply"), u("last ask"), a("last reply")];

	it("clips an old user message to 2000 head + 1000 tail with an omission marker", () => {
		const content = "H".repeat(2000) + "M".repeat(500) + "T".repeat(1000);
		const out = truncateHistory([u(content), a("ok"), ...tail], 4);
		expect(summaryOf(out)).toContain(
			`<prior_user>${"H".repeat(2000)} … [500 chars omitted] … ${"T".repeat(1000)}</prior_user>`,
		);
	});

	it("keeps an old user message of exactly 3000 chars verbatim (no clip)", () => {
		const content = "H".repeat(2000) + "T".repeat(1000);
		const out = truncateHistory([u(content), a("ok"), ...tail], 4);
		expect(summaryOf(out)).toContain(`<prior_user>${content}</prior_user>`);
	});

	it("clips an old assistant message at 300 chars", () => {
		const out = truncateHistory([u("q"), a("b".repeat(350)), ...tail], 4);
		expect(summaryOf(out)).toContain(`<prior_assistant>${"b".repeat(300)}…</prior_assistant>`);
	});

	it("clips an old tool result at 200 chars", () => {
		const toolRow = { role: "tool", content: "t".repeat(250), tool_call_id: "call_1" } as unknown as ChatCompletionMessageParam;
		const out = truncateHistory([u("q"), toolRow, a("done"), ...tail], 4);
		expect(summaryOf(out)).toContain(`<prior_tool_result>${"t".repeat(200)}…</prior_tool_result>`);
	});

	it("spends the 24k char budget newest-first and marks the omitted head", () => {
		// 20 old user rows, 3000 chars each → 3025-char digest lines. Newest-first
		// only 7 fit under 24_000; the older 13 collapse to an omission marker.
		const old: ChatCompletionMessageParam[] = [];
		for (let i = 0; i < 20; i++) old.push(u(`M${String(i).padStart(2, "0")}${"x".repeat(2997)}`));
		const summary = summaryOf(truncateHistory([...old, ...tail], 4));
		expect(summary).toContain('<prior_conversation count="20">');
		expect(summary).toContain('<prior_omitted count="13"/>');
		expect(summary.match(/<prior_user>/g)).toHaveLength(7);
		expect(summary).toContain("M13"); // newest 7 (13..19) survive…
		expect(summary).toContain("M19");
		expect(summary).not.toContain("M12"); // …older ones don't
	});

	it("preserves a leading system row (manual /api/compact summary) ahead of the digest", () => {
		const leader: ChatCompletionMessageParam = { role: "system", content: "[COMPACTED CONTEXT] earlier" };
		const out = truncateHistory([leader, ...alternating(40)], 30);
		expect(out[0]).toBe(leader);
		expect(out[1].role).toBe("system");
		expect(out[1].content).toContain('<prior_conversation count="10">');
	});
});

// GOLDEN for the `_error` boundary row canonical-run.ts writes after a
// terminal stream error: the provider copy carries the canonical sentence
// exactly once, the structural flag never leaks, recovered errors (no row)
// leave no marker, and the row survives the working-window cut.
describe("golden: terminal-error boundary at the provider seam", () => {
	const ERR = { code: "http_400", message: "text content blocks must be non-empty" };
	const BOUNDARY = renderTurnErrorBoundary(ERR);
	const errorRow = (content: string): ChatCompletionMessageParam =>
		({ role: "assistant", content, _error: ERR }) as ChatCompletionMessageParam;
	const copiesIn = (m: ChatCompletionMessageParam): number =>
		String(m.content).split(TURN_ERROR_BOUNDARY_HEAD).length - 1;

	it("renders the canonical sentence with the code and message", () => {
		expect(BOUNDARY).toBe(
			"[The previous assistant turn ended with an error (http_400: text content blocks must be non-empty). " +
			"Work completed before the error stands; do not repeat side-effecting actions — explain the error to the user and continue from the current state.]",
		);
	});

	it("the chat path's standalone _error row reaches the provider verbatim, once, flag stripped", () => {
		const out = sanitizeHistory([u("q"), errorRow(BOUNDARY)]);
		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ role: "assistant", content: BOUNDARY });
		expect(copiesIn(out[1])).toBe(1);
	});

	it("an _error flag on a speech row appends the boundary once after the speech", () => {
		const out = sanitizeHistory([u("q"), errorRow("Starting on it.")]);
		expect(out[1]).toEqual({ role: "assistant", content: `Starting on it.\n\n${BOUNDARY}` });
	});

	it("never twice: a flagged row that also carries an echoed copy renders one boundary", () => {
		const out = sanitizeHistory([u("q"), errorRow(`Starting on it. ${BOUNDARY} As I was saying.`)]);
		expect(copiesIn(out[1])).toBe(1);
		expect(out[1].content).toBe(`Starting on it. As I was saying.\n\n${BOUNDARY}`);
	});

	it("a model echo inside unflagged speech is scrubbed, not re-rendered (mangled close tolerated)", () => {
		const out = sanitizeHistory([u("q"), a(`Sure. ${BOUNDARY} Done. ${BOUNDARY.slice(0, -1)} Really.`)]);
		expect(out[1].content).toBe("Sure. Done. Really.");
		expect(copiesIn(out[1])).toBe(0);
	});

	it("no _error row → no marker anywhere (a recovered error leaves no trace)", () => {
		const out = buildCleanHistory(alternating(50), "web");
		for (const m of out) expect(copiesIn(m)).toBe(0);
	});

	it("truncation keeps the _error row in the working window", () => {
		// 48 alternating rows, then the errored turn in the 400 shape: user row, boundary, no speech.
		const out = buildCleanHistory([...alternating(48), u("last ask"), errorRow(BOUNDARY)], "web");
		expect(out).toHaveLength(41);
		expect(out[out.length - 1]).toEqual({ role: "assistant", content: BOUNDARY });
		expect(out.filter((m) => copiesIn(m) > 0)).toHaveLength(1);
	});

	it("an _error row that ages out of the window survives in the digest", () => {
		const out = buildCleanHistory([u("first ask"), errorRow(BOUNDARY), ...alternating(48)], "web");
		expect(summaryOf(out)).toContain(`<prior_assistant>${TURN_ERROR_BOUNDARY_HEAD}http_400: `);
	});

	// The partial-text shape: the turn spoke ("Starting on it.") and THEN died,
	// so canonical-run writes a standalone boundary row right after the speech
	// row. sanitizeHistory coalesces the two for the provider — but the speech
	// row it coalesces INTO is the live session.messages object (callers pass
	// stored history uncopied). Merging in place used to persist the boundary
	// into the stored speech row, so the reloaded transcript showed the sentence
	// twice. The provider copy gets the merge; stored rows stay byte-identical.
	it("coalescing speech + boundary for the provider never mutates the stored speech row", () => {
		const speech = a("Starting on it.");
		const boundary = errorRow(BOUNDARY);
		const stored = [u("q"), speech, boundary];
		const out = sanitizeHistory(stored);
		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ role: "assistant", content: `Starting on it.\n${BOUNDARY}` });
		expect(speech).toEqual({ role: "assistant", content: "Starting on it." });
		expect(boundary).toEqual({ role: "assistant", content: BOUNDARY, _error: ERR });
		expect(stored).toHaveLength(3);
	});

	it("coalescing a user run (3x bridge messages) leaves the stored rows untouched too", () => {
		const stored = [u("hey"), u("hey"), u("hey"), a("hi")];
		const snapshot = stored.map((m) => ({ ...m }));
		const out = sanitizeHistory(stored);
		expect(out).toEqual([{ role: "user", content: "hey\nhey\nhey" }, { role: "assistant", content: "hi" }]);
		expect(stored).toEqual(snapshot);
	});
});
