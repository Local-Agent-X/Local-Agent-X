// @vitest-environment happy-dom
//
// "Always for this session" was offered on every card, including the ones the
// server never remembers (alwaysAsk: the un-named delete card, irreversible ops,
// policy-required asks). Ticking it did nothing — a control that silently does
// nothing (2026-09-26, the ns_tmp card). The server now says whether an ask can
// be remembered, and the card offers the box only when it can.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getApprovalManager } from "../src/approval-manager.js";
import type { ServerEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

function makeCard(rememberable?: boolean): HTMLElement {
	const g = globalThis as unknown as Record<string, unknown>;
	g.esc = (s: string) => s;
	const src = readFileSync(join(here, "../public/js/chat-tool-cards.js"), "utf8");
	const { makeApprovalCard } = new Function(src + "\nreturn { makeApprovalCard };")() as {
		makeApprovalCard: (...a: unknown[]) => HTMLElement;
	};
	return rememberable === undefined
		? makeApprovalCard("a1", "delete_file", "ctx", "")
		: makeApprovalCard("a1", "delete_file", "ctx", "", rememberable);
}

async function askedEvent(alwaysAsk: boolean): Promise<Extract<ServerEvent, { type: "approval_requested" }>> {
	const events: ServerEvent[] = [];
	const mgr = getApprovalManager();
	const sid = `sess-remember-${alwaysAsk}`;
	const settled = mgr.requestApprovalDetailed({
		toolName: "delete_file", toolCallId: "c1", sessionId: sid, context: "x",
		args: { path: `/tmp/remember-${alwaysAsk}` }, alwaysAsk, emit: (e) => events.push(e),
	});
	const asked = events.find((e) => e.type === "approval_requested");
	mgr.clearSession(sid);
	await settled;
	return asked as Extract<ServerEvent, { type: "approval_requested" }>;
}

describe("Always for this session is offered only when it would be honored", () => {
	it("an alwaysAsk ask says it cannot be remembered; an ordinary ask says it can", async () => {
		expect((await askedEvent(true)).rememberable).toBe(false);
		expect((await askedEvent(false)).rememberable).toBe(true);
	});

	it("a card that cannot be remembered has no checkbox; the default still has one", () => {
		expect(makeCard(false).querySelector(".always-cb")).toBeNull();
		expect(makeCard(true).querySelector(".always-cb")).not.toBeNull();
		expect(makeCard().querySelector(".always-cb")).not.toBeNull();
	});
});
