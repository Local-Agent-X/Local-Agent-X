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

	// Live 2026-11-20: the code session opened blank and waited for the user to
	// say "go". The click is the go-ahead, so the session's first turn starts.
	it("the opened code session starts its first turn on the brief", async () => {
		document.body.innerHTML = '<textarea id="msg-input"></textarea>';
		const sent: string[] = [];
		const selected: string[] = [];
		const stubs = {
			chats: [{ id: "chat-1", messages: [{ role: "user", content: "move it" }] }],
			apiFetch: vi.fn(async (url: string) => ({
				json: async () => url === "/api/sessions/fork"
					? { ok: true, forkId: "fork-1", title: "Code: x", projectId: "p-1" }
					: { messages: [{ role: "system", content: "[HANDOFF]" }] },
			})),
			saveChats: vi.fn(),
			setSidebarMode: vi.fn(),
			selectChat: (id: string) => selected.push(id),
			sendMessage: () => sent.push((document.getElementById("msg-input") as HTMLTextAreaElement).value),
		};
		const run = new Function(...Object.keys(stubs), src("chat.js") + "\nreturn continueInCodeSession;")(...Object.values(stubs)) as
			(id: string, e: null, h?: { folder: string; brief: string }) => Promise<boolean>;
		expect(await run("chat-1", null, { folder: EVENT.folder, brief: EVENT.brief })).toBe(true);
		expect(selected).toEqual(["fork-1"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain(EVENT.brief);
	});

	// Live 2026-11-20: the sidebar's ⌨ forked the whole chat into a code
	// session with no folder and no brief, which opened under "No folder".
	function sidebarMove(messages: unknown[]) {
		document.body.innerHTML = '<textarea id="msg-input"></textarea>';
		const sent: string[] = [];
		const selected: string[] = [];
		const forks: unknown[] = [];
		const stubs = {
			chats: [{ id: "chat-1", messages }],
			apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
				if (url === "/api/sessions/fork") forks.push(JSON.parse(init?.body ?? "{}"));
				return { json: async () => url === "/api/sessions/fork" ? { ok: true, forkId: "fork-3", title: "Code: x" } : { messages: [] } };
			}),
			saveChats: vi.fn(),
			setSidebarMode: vi.fn(),
			selectChat: (id: string) => selected.push(id),
			sendMessage: () => sent.push((document.getElementById("msg-input") as HTMLTextAreaElement).value),
		};
		const move = new Function(...Object.keys(stubs), src("chat.js") + "\nreturn moveChatToCode;")(...Object.values(stubs)) as
			(id: string, e: null) => Promise<void>;
		return { move, sent, selected, forks };
	}

	it("the sidebar move opens the chat's handoff offer when it has one", async () => {
		const offer = { id: "ch-tc-1", kind: "handoff", folder: EVENT.folder, brief: EVENT.brief, status: "offered" };
		const s = sidebarMove([{ role: "user", content: "move it" }, { role: "assistant", content: "ok", _notices: [offer] }]);
		await s.move("chat-1", null);
		expect(s.forks).toEqual([expect.objectContaining({ mode: "code", handoff: { folder: EVENT.folder, brief: EVENT.brief } })]);
		expect(s.selected).toEqual(["fork-3"]);
		expect(s.sent[0]).toContain(EVENT.brief);
		expect(offer.status).toBe("opened");
	});

	it("with no offer, the sidebar move asks the chat's agent for one and forks nothing", async () => {
		const s = sidebarMove([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
		await s.move("chat-1", null);
		expect(s.forks).toEqual([]);
		expect(s.selected).toEqual(["chat-1"]);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]).toMatch(/handoff brief/);
	});
});
