// Handler tests for the `recall` tool — fixture OpMessageRows fed through the
// REAL sealed adapter (opMessageRowToChatParam) with the store + op-store
// mocked via injected deps. Covers paging, cursor + range-cursor extraction,
// low/high detail, truncation hints, output cap, and session→op resolution.

import { describe, it, expect } from "vitest";
import { createRecallTool, parseCursor, pageMessages, type RecallDeps } from "./recall-tool.js";
import { opMessageRowToChatParam } from "../canonical-loop/chat-runner/message-convert.js";
import type { OpMessageRow } from "../canonical-loop/types.js";

function row(id: string, role: OpMessageRow["role"], content: unknown, turnIdx = 0): OpMessageRow {
	return { messageId: id, opId: "op-1", turnIdx, seqInTurn: 0, role, content, createdAt: "2026-07-13T10:00:00.000Z" };
}

function userRow(id: string, text: string): OpMessageRow { return row(id, "user", { text }); }
function asstRow(id: string, text: string): OpMessageRow { return row(id, "assistant", { text }); }

function deps(
	rows: OpMessageRow[],
	ops: Array<{ id: string; canonical?: { sessionId?: string | null } }> = [{ id: "op-1", canonical: { sessionId: "sess-A" } }],
): RecallDeps {
	return {
		readOpMessages: () => rows,
		toChatParam: opMessageRowToChatParam,
		listOps: () => ops,
	};
}

function nMessages(n: number): OpMessageRow[] {
	const out: OpMessageRow[] = [];
	for (let i = 1; i <= n; i++) {
		out.push(i % 2 === 1 ? userRow(`m${i}`, `message ${i}`) : asstRow(`m${i}`, `message ${i}`));
	}
	return out;
}

async function run(d: RecallDeps, args: Record<string, unknown>) {
	return createRecallTool(d).execute({ _sessionId: "sess-A", ...args });
}

describe("parseCursor", () => {
	it("passes a bare messageId through", () => {
		expect(parseCursor("m17")).toEqual({ startId: "m17" });
	});
	it("extracts start and end from a startId:endId range", () => {
		expect(parseCursor("m10:m19")).toEqual({ startId: "m10", endId: "m19" });
	});
});

describe("session→op resolution", () => {
	const rows = nMessages(3);
	it("picks the newest op whose canonical sessionId matches (listOps is newest-first)", async () => {
		let readOpId = "";
		const d: RecallDeps = {
			...deps(rows, [
				{ id: "op-other", canonical: { sessionId: "sess-B" } },
				{ id: "op-newest-A", canonical: { sessionId: "sess-A" } },
				{ id: "op-older-A", canonical: { sessionId: "sess-A" } },
			]),
			readOpMessages: (opId) => { readOpId = opId; return rows; },
		};
		const res = await run(d, {});
		expect(readOpId).toBe("op-newest-A");
		expect(res.isError).toBeFalsy();
	});
	it("same-session historical opId selects that op", async () => {
		let readOpId = "";
		const d: RecallDeps = {
			...deps(rows, [
				{ id: "op-newest-A", canonical: { sessionId: "sess-A" } },
				{ id: "op-older-A", canonical: { sessionId: "sess-A" } },
			]),
			readOpMessages: (opId) => { readOpId = opId; return rows; },
		};
		const res = await run(d, { opId: "op-older-A" });
		expect(res.isError).toBeFalsy();
		expect(readOpId).toBe("op-older-A");
	});
	it("cross-session opId errors, indistinguishably from an unknown opId", async () => {
		let readCalled = false;
		const d: RecallDeps = {
			...deps(rows, [
				{ id: "op-mine", canonical: { sessionId: "sess-A" } },
				{ id: "op-theirs", canonical: { sessionId: "sess-B" } },
			]),
			readOpMessages: () => { readCalled = true; return rows; },
		};
		const crossSession = await run(d, { opId: "op-theirs" });
		expect(crossSession.isError).toBe(true);
		expect(readCalled).toBe(false); // never reached the store
		const unknown = await run(d, { opId: "op-nonexistent" });
		expect(unknown.isError).toBe(true);
		expect(readCalled).toBe(false);
		// same shape either way — existence of the foreign op is not leaked
		expect(crossSession.content.replace("op-theirs", "X")).toBe(unknown.content.replace("op-nonexistent", "X"));
	});
	it("errors when no session is in scope", async () => {
		const res = await createRecallTool(deps(rows)).execute({});
		expect(res.isError).toBe(true);
	});
	it("errors when no session is in scope even with an explicit opId (no unscoped path)", async () => {
		let readCalled = false;
		const d: RecallDeps = { ...deps(rows), readOpMessages: () => { readCalled = true; return rows; } };
		const res = await createRecallTool(d).execute({ opId: "op-1" });
		expect(res.isError).toBe(true);
		expect(readCalled).toBe(false);
	});
	it("reports cleanly when the session has no ops yet", async () => {
		const res = await run(deps(rows, []), {});
		expect(res.isError).toBeFalsy();
		expect(res.content).toMatch(/No recorded operation/);
	});
});

describe("paging (low detail)", () => {
	const rows = nMessages(45);
	it("page 1 returns the most recent `limit` messages, oldest→newest", async () => {
		const res = await run(deps(rows), { limit: 20 });
		expect(res.content).toContain("messages 26–45 of 45");
		expect(res.content).toContain("[m26]");
		expect(res.content).toContain("[m45]");
		expect(res.content).not.toContain("[m25]");
	});
	it("page 2 returns the next page back in time", async () => {
		const res = await run(deps(rows), { limit: 20, page: 2 });
		expect(res.content).toContain("messages 6–25 of 45");
		expect(res.content).not.toContain("[m26]");
	});
	it("last page clamps at the start of history", async () => {
		const res = await run(deps(rows), { limit: 20, page: 3 });
		expect(res.content).toContain("messages 1–5 of 45");
		expect(res.content).toContain("[m1]");
	});
	it("a bare cursor pages strictly BEFORE that message", async () => {
		const res = await run(deps(rows), { cursor: "m31", limit: 20 });
		expect(res.content).toContain("[m30]");
		expect(res.content).toContain("[m11]");
		expect(res.content).not.toContain("[m31]");
	});
	it("a range cursor scopes paging inside the range, first page first", async () => {
		const p1 = await run(deps(rows), { cursor: "m10:m19", limit: 5 });
		expect(p1.content).toContain("[m10]");
		expect(p1.content).toContain("[m14]");
		expect(p1.content).not.toContain("[m9]");
		expect(p1.content).not.toContain("[m15]");
		const p2 = await run(deps(rows), { cursor: "m10:m19", limit: 5, page: 2 });
		expect(p2.content).toContain("[m15]");
		expect(p2.content).toContain("[m19]");
		expect(p2.content).not.toContain("[m20]");
	});
	it("an inverted range cursor errors instead of returning a silent empty page", async () => {
		const res = await run(deps(rows), { cursor: "m19:m10", limit: 5 });
		expect(res.isError).toBe(true);
		expect(res.content).toMatch(/inverted/);
		expect(res.content).toContain("m19");
		expect(res.content).toContain("m10");
	});
	it("an unknown cursor errors instead of guessing", async () => {
		const res = await run(deps(rows), { cursor: "nope-123" });
		expect(res.isError).toBe(true);
		expect(res.content).toMatch(/not found/);
	});
	it("limit is capped at 50", () => {
		const msgs = nMessages(120).map(r => ({ row: r, param: opMessageRowToChatParam(r)! }));
		const res = pageMessages(msgs, { page: 1, limit: 50 });
		expect(res.slice.length).toBe(50);
	});
});

describe("low-detail rendering", () => {
	it("skips synthetic nudge rows (adapter returns null)", async () => {
		const rows = [userRow("m1", "hello"), row("m2", "user", { text: "synthetic", kind: "nudge" }), asstRow("m3", "hi")];
		const res = await run(deps(rows), {});
		expect(res.content).toContain("of 2");
		expect(res.content).not.toContain("synthetic");
	});
	it("truncates long text at ~200 chars and appends the exact follow-up hint", async () => {
		const long = "x".repeat(600);
		const res = await run(deps([userRow("m1", "short"), asstRow("m2", long)]), {});
		expect(res.content).not.toContain("x".repeat(300));
		expect(res.content).toContain('[truncated — call recall with cursor="m2" detail="high" for full content]');
	});
	it("shows tool names for assistant tool-call rows", async () => {
		const rows = [
			asstRow("m1", ""),
			row("m2", "assistant", { text: "", toolCalls: [{ id: "c1", name: "web_search", arguments: "{\"q\":1}" }] }),
			row("m3", "tool_result", { toolCallId: "c1", result: "found it" }),
		];
		const res = await run(deps(rows), {});
		expect(res.content).toContain("calls: web_search");
		expect(res.content).toContain("found it");
	});
	it("caps total output near 6k chars and says how to page back to the omitted messages", async () => {
		const rows = nMessages(30).map((r, i) => ({ ...r, content: { text: `msg ${i + 1} ${"y".repeat(400)}` } }));
		const res = await run(deps(rows), { limit: 30 });
		expect(res.content).toMatch(/output capped — \d+ older message\(s\) omitted/);
		expect(res.content).toContain('call recall with cursor="');
		// cap is honest: the note/hints are inside the budget, not on top of it
		expect(res.content.length).toBeLessThanOrEqual(6000);
	});
});

describe("high detail", () => {
	it("returns one message's full content with adjacent-message hints", async () => {
		const long = "z".repeat(600);
		const res = await run(deps([userRow("m1", "before"), asstRow("m2", long), userRow("m3", "after")]), { cursor: "m2", detail: "high" });
		expect(res.content).toContain(long);
		expect(res.content).toContain('cursor="m1" detail="high"');
		expect(res.content).toContain('cursor="m3" detail="high"');
	});
	it("defaults to the newest message when no cursor is given", async () => {
		const res = await run(deps(nMessages(5)), { detail: "high" });
		expect(res.content).toContain("[m5]");
		expect(res.content).toContain("message 5");
	});
	it("returns part 0 of an oversized message with a partIndex continuation hint", async () => {
		const big = "a".repeat(5000) + "b".repeat(5000) + "c".repeat(2000);
		const res = await run(deps([userRow("m1", big)]), { cursor: "m1", detail: "high" });
		expect(res.content).toContain("[p0] " + "a".repeat(20));
		expect(res.content).not.toContain("c".repeat(20));
		expect(res.content).toContain('detail="high" partIndex=1');
	});
	it("partIndex selects one part and hints at its neighbors", async () => {
		const big = "a".repeat(5000) + "b".repeat(5000) + "c".repeat(2000);
		const res = await run(deps([userRow("m1", big)]), { cursor: "m1", detail: "high", partIndex: 2 });
		expect(res.content).toContain("c".repeat(2000));
		expect(res.content).not.toContain("b".repeat(100));
		expect(res.content).toContain("[previous part: partIndex=1]");
	});
	it("errors on an unknown high-detail cursor", async () => {
		const res = await run(deps(nMessages(3)), { cursor: "ghost", detail: "high" });
		expect(res.isError).toBe(true);
	});
	it("a range cursor in high detail reads the range's start message", async () => {
		const res = await run(deps(nMessages(10)), { cursor: "m4:m8", detail: "high" });
		expect(res.content).toContain("[m4]");
		expect(res.content).toContain("message 4");
	});
});
