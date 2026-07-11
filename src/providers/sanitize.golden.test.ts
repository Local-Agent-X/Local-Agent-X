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

import { buildCleanHistory, truncateHistory } from "./sanitize.js";

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
