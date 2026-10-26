// @vitest-environment happy-dom
//
// The Code mode handoff on a chat: the agent's code_handoff event becomes a
// notice on the turn (once, however often it is re-delivered), and its button
// runs the move with the repo and the brief, then says it moved instead of
// offering again. Live 2026-10-25: asked "should we be doing this in code
// mode?", the agent did not know Code mode existed and the work never moved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
const g = globalThis as unknown as Record<string, unknown>;

type Notice = { id: string; kind: string; folder: string; brief: string; status: string; error?: string };

const EVENT = { type: "code_handoff", toolCallId: "tc-1", folder: "C:\\Users\\peter\\Scan Progress", brief: "docs/handoff/planner.md" };

function renderer(): (n: Notice) => HTMLElement {
	g.esc = (s: string) => String(s).replace(/</g, "&lt;");
	return new Function(src("chat-render-notices.js") + "\nreturn renderHandoffNotice;")() as (n: Notice) => HTMLElement;
}

function reduce(events: unknown[]): { notices?: Notice[] } {
	new Function(src("chat-stream-reducer.js"))();
	const reducer = g._chatStreamReduce as (e: unknown, ev: unknown, now: number, helpers: unknown) => void;
	const entry = { doneOpIds: new Set(), notices: undefined as Notice[] | undefined };
	for (const ev of events) reducer(entry, ev, 0, {});
	return entry;
}

describe("the Code mode handoff notice", () => {
	beforeEach(() => { document.body.innerHTML = ""; });

	it("lands on the turn once, however often the event is re-delivered", () => {
		const entry = reduce([EVENT, EVENT]);
		expect(entry.notices).toEqual([{ id: "ch-tc-1", kind: "handoff", folder: EVENT.folder, brief: EVENT.brief, status: "offered" }]);
	});

	it("its button moves the chat with the repo and the brief, then says it moved", async () => {
		const render = renderer();
		const calls: unknown[][] = [];
		g.activeChat = { id: "chat-1" };
		g.continueInCodeSession = vi.fn(async (...args: unknown[]) => { calls.push(args); return true; });
		g.saveChats = vi.fn();
		const n: Notice = { id: "ch-tc-1", kind: "handoff", folder: EVENT.folder, brief: EVENT.brief, status: "offered" };
		const el = render(n);
		expect(el.textContent).toContain("Continue in Code mode");
		(el.querySelector(".handoff-notice-open") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(n.status).toBe("opened"));
		expect(calls).toEqual([["chat-1", null, { folder: EVENT.folder, brief: EVENT.brief }]]);
		expect(el.textContent).toContain("Moved to Code mode");
		expect(el.querySelector(".handoff-notice-open")).toBeNull();
	});

	it("says so when the move fails, and keeps the button", async () => {
		const render = renderer();
		g.activeChat = { id: "chat-1" };
		g.continueInCodeSession = vi.fn(async () => false);
		g.saveChats = vi.fn();
		const n: Notice = { id: "ch-tc-2", kind: "handoff", folder: EVENT.folder, brief: EVENT.brief, status: "offered" };
		const el = render(n);
		(el.querySelector(".handoff-notice-open") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(n.error).toBeTruthy());
		expect(el.querySelector(".handoff-notice-open")).not.toBeNull();
	});
});
