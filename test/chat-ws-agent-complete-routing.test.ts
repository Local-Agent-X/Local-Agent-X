// Routing of `agent-complete` broadcasts into chat — C4b (2026-08-31).
//
// Background: handler-events.ts broadcasts agent-complete to EVERY socket with
// no session scoping, and the client appended the report to whatever chat was
// open. Every auto-build chunk runner's STATUS/DONE_WHEN block landed in the
// open chat that way — once from the server's session injection and once from
// this client append. The sibling server chunk (C4a) stamps the payload with
// `sessionId` (string, "" when unknown) and `parentAgentId` (string | null);
// these tests pin the client's decision table on top of that contract:
//   parentAgentId set        → sidebar card only (no chat row, no notification)
//   sessionId === active     → render live + store on the active chat
//   sessionId names another  → store on that chat only, never rendered, and
//                              WITHOUT bumping updatedAt (hydrateChat's keptLocal
//                              guard would otherwise let a one-row stub beat the
//                              full server history)
//   sessionId ""             → the spawn had no parent session (auto-fix
//                              workers, wakeup, issue-update, escalation, the
//                              templates route); the server persists no chat
//                              row for these → card only, no notification
//   sessionId key absent     → pre-C4a server: legacy append to the open chat
//
// The rendered row is byte-identical to the server's persisted row
// (`**Agent <name> completed|failed:**\n\n<result>`, no ✅/❌ prefix, no row
// at all for an empty result) so the next hydrate classifies it 'skip'
// instead of a full repaint that swaps it. The canonical format is the
// server's agentCompleteChatRow; the browser script can't import it, so the
// drift gate below runs BOTH builders over the full success × result matrix
// and asserts byte equality — a change to either file breaks CI.
//
// `success` is tri-state: true → succeeded, false → failed, absent/undefined
// → completed with unknown status. Only an explicit false may read "failed"
// anywhere (card status, chat row) — the server records "succeeded" and says
// "completed" for undefined.
//
// chat-ws-handler-misc.js is a classic browser global-script, so — like
// chat-ws-process-relay.test.ts — its source is evaluated in a Function factory
// with the globals it reaches for passed in as parameters.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentCompleteChatRow } from "../src/server/handler-events-agent-result.js";

const miscSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler-misc.js"), "utf8");
const handlerSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler.js"), "utf8");

type Row = { role: string; content: string };
type Chat = { id: string; messages: Row[]; updatedAt: number; _needsHydrate?: boolean };
type Route = { render: boolean; store: string | null; notify: boolean };
type Msg = Record<string, unknown>;

function chat(id: string, rows: Row[] = [], updatedAt = 1_000): Chat {
	return { id, messages: rows.slice(), updatedAt };
}

function loadMisc(activeChat: Chat | null, chats: Chat[]) {
	const addMessageEl = vi.fn();
	const saveChats = vi.fn();
	const updateAgentFeed = vi.fn();
	const factory = new Function("activeChat", "chats", "addMessageEl", "saveChats", "updateAgentFeed", `
		var window = {};
		var setTimeout = function() {};
		${miscSource}
		return { handleAgentFeedEvent, agentCompleteRouting, buildAgentCompleteRow };
	`);
	const api = factory(activeChat, chats, addMessageEl, saveChats, updateAgentFeed) as {
		handleAgentFeedEvent: (msg: Msg) => void;
		agentCompleteRouting: (msg: Msg, activeChatId: string | null) => Route;
		buildAgentCompleteRow: (msg: Msg) => string | null;
	};
	return { ...api, addMessageEl, saveChats, updateAgentFeed };
}

function loadHandler(activeChat: Chat | null, chats: Chat[]) {
	const showNotification = vi.fn();
	const addMessageEl = vi.fn();
	const saveChats = vi.fn();
	const factory = new Function("activeChat", "chats", "addMessageEl", "saveChats", "showNotification", `
		var window = { desktop: { showNotification: showNotification } };
		var setTimeout = function() {};
		var updateAgentFeed = function() {};
		${miscSource}
		${handlerSource}
		return { dispatchChatWsNonEvent };
	`);
	const api = factory(activeChat, chats, addMessageEl, saveChats, showNotification) as {
		dispatchChatWsNonEvent: (msg: Msg) => void;
	};
	return { ...api, showNotification, addMessageEl };
}

const done = (extra: Msg = {}): Msg => ({
	type: "agent-complete", agentId: "ag-1", name: "Worker", success: true, result: "STATUS: green", ...extra,
});
// Must match the server's persisted row exactly (handler-events-agent-result.ts).
const REPORT = "**Agent Worker completed:**\n\nSTATUS: green";

describe("agentCompleteRouting (pure decision table)", () => {
	const { agentCompleteRouting } = loadMisc(null, []);

	it("parentAgentId set → card only: no render, no store, no notification — even for the active session", () => {
		expect(agentCompleteRouting({ parentAgentId: "orch-1", sessionId: "chat-a" }, "chat-a"))
			.toEqual({ render: false, store: null, notify: false });
	});

	it("parentAgentId null (chat-initiated spawn) is NOT a child", () => {
		expect(agentCompleteRouting({ parentAgentId: null, sessionId: "chat-a" }, "chat-a").render).toBe(true);
	});

	it("sessionId === active → render + store on it", () => {
		expect(agentCompleteRouting({ sessionId: "chat-a" }, "chat-a")).toEqual({ render: true, store: "chat-a", notify: true });
	});

	it("sessionId names another chat → store there, never render", () => {
		expect(agentCompleteRouting({ sessionId: "chat-b" }, "chat-a")).toEqual({ render: false, store: "chat-b", notify: true });
	});

	it('sessionId "" (spawn had no parent session) → card only: the server persisted no chat row', () => {
		expect(agentCompleteRouting({ parentAgentId: null, sessionId: "" }, "chat-a")).toEqual({ render: false, store: null, notify: false });
		expect(agentCompleteRouting({ parentAgentId: null, sessionId: "" }, null)).toEqual({ render: false, store: null, notify: false });
	});

	it("sessionId key absent (pre-C4a server) → legacy append to the open chat", () => {
		expect(agentCompleteRouting({}, "chat-a")).toEqual({ render: true, store: "chat-a", notify: true });
		expect(agentCompleteRouting({}, null)).toEqual({ render: true, store: null, notify: true });
	});
});

describe("handleAgentFeedEvent(agent-complete)", () => {
	it("orchestrator child: updates the card, appends nothing, saves nothing", () => {
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done({ parentAgentId: "orch-1", sessionId: "chat-a" }));
		expect(h.updateAgentFeed).toHaveBeenCalledWith("ag-1", expect.objectContaining({ status: "succeeded" }));
		expect(h.addMessageEl).not.toHaveBeenCalled();
		expect(h.saveChats).not.toHaveBeenCalled();
		expect(active.messages).toHaveLength(1);
		expect(active.updatedAt).toBe(1_000);
	});

	it("sessionId === active: renders live, stores on the active chat, bumps updatedAt, saves", () => {
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const other = chat("chat-b");
		const h = loadMisc(active, [active, other]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-a" }));
		expect(h.addMessageEl).toHaveBeenCalledTimes(1);
		expect(h.addMessageEl).toHaveBeenCalledWith("assistant", REPORT);
		expect(active.messages).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: REPORT }]);
		expect(active.updatedAt).toBeGreaterThan(1_000);
		expect(other.messages).toHaveLength(0);
		expect(h.saveChats).toHaveBeenCalledTimes(1);
	});

	it("sessionId names another chat: never rendered into the open view, stored on that chat", () => {
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const other = chat("chat-b"); // metadata stub — messages: [] until hydrate
		const h = loadMisc(active, [active, other]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-b" }));
		expect(h.addMessageEl).not.toHaveBeenCalled();
		expect(active.messages).toHaveLength(1);
		expect(other.messages).toEqual([{ role: "assistant", content: REPORT }]);
		expect(h.saveChats).toHaveBeenCalledTimes(1);
	});

	it("other-chat store does NOT bump updatedAt (keptLocal guard) and flags a re-hydrate", () => {
		const active = chat("chat-a");
		const other = chat("chat-b", [], 1_000);
		const h = loadMisc(active, [active, other]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-b" }));
		expect(other.updatedAt).toBe(1_000);
		expect(other._needsHydrate).toBe(true);
		expect(active._needsHydrate).toBeUndefined();
	});

	it("sessionId names a chat this client does not hold: nothing rendered or stored", () => {
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-zzz" }));
		expect(h.addMessageEl).not.toHaveBeenCalled();
		expect(h.saveChats).not.toHaveBeenCalled();
		expect(active.messages).toHaveLength(1);
	});

	it('sessionId "": no parent session — card updated, nothing appended or saved (no ghost row)', () => {
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "" }));
		expect(h.updateAgentFeed).toHaveBeenCalledWith("ag-1", expect.objectContaining({ status: "succeeded" }));
		expect(h.addMessageEl).not.toHaveBeenCalled();
		expect(h.saveChats).not.toHaveBeenCalled();
		expect(active.messages).toHaveLength(1);
		expect(active.updatedAt).toBe(1_000);
	});

	it("sessionId key absent (pre-C4a server): legacy — appends to whatever chat is open", () => {
		const active = chat("chat-a");
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done());
		expect(h.addMessageEl).toHaveBeenCalledWith("assistant", REPORT);
		expect(active.messages).toEqual([{ role: "assistant", content: REPORT }]);
		expect(h.saveChats).toHaveBeenCalledTimes(1);
	});

	it("failure shape uses the server's `failed` wording (no icon) and the failed card status", () => {
		const active = chat("chat-a");
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-a", success: false, result: "Agent timed out" }));
		expect(h.updateAgentFeed).toHaveBeenCalledWith("ag-1", expect.objectContaining({ status: "failed" }));
		expect(h.addMessageEl).toHaveBeenCalledWith("assistant", "**Agent Worker failed:**\n\nAgent timed out");
	});

	it("empty result → no chat row on any path (mirrors the server's evt.result persistence gate)", () => {
		// The server persists nothing for an empty result, so a synthesized
		// 'Done.'/'Agent failed.' row here would silently vanish (or swap) on
		// the next server-wins hydrate. Card + notification still report it.
		const active = chat("chat-a", [{ role: "user", content: "hi" }]);
		const h = loadMisc(active, [active]);
		h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-a", success: false, result: "" }));
		h.handleAgentFeedEvent(done({ result: "" })); // legacy path (no sessionId key)
		expect(h.updateAgentFeed).toHaveBeenCalledWith("ag-1", expect.objectContaining({ status: "failed" }));
		expect(h.addMessageEl).not.toHaveBeenCalled();
		expect(h.saveChats).not.toHaveBeenCalled();
		expect(active.messages).toHaveLength(1);
	});
});

describe("success tri-state (card status + row wording agree with the server)", () => {
	const cases: Array<{ success: boolean | undefined; card: string; word: string }> = [
		{ success: true, card: "succeeded", word: "completed" },
		{ success: false, card: "failed", word: "failed" },
		// undefined = completed with unknown status. The server records
		// "succeeded" and persists "completed" — rendering "failed" here made
		// the client disagree with its own reload.
		{ success: undefined, card: "succeeded", word: "completed" },
	];
	for (const c of cases) {
		it(`success: ${String(c.success)} → card '${c.card}', row '${c.word}'`, () => {
			const active = chat("chat-a");
			const h = loadMisc(active, [active]);
			h.handleAgentFeedEvent(done({ parentAgentId: null, sessionId: "chat-a", success: c.success, result: "r" }));
			expect(h.updateAgentFeed).toHaveBeenCalledWith("ag-1", expect.objectContaining({ status: c.card }));
			expect(h.addMessageEl).toHaveBeenCalledWith("assistant", `**Agent Worker ${c.word}:**\n\nr`);
		});
	}
});

describe("client render ↔ server persistence: byte-identical (drift gate)", () => {
	// The canonical format is the server's agentCompleteChatRow
	// (src/server/handler-events-agent-result.ts); the browser global-script
	// can't import it, so this gate evaluates both builders and asserts byte
	// equality over the whole input space (both are pure functions of
	// name × success × result). Editing the literal in either file without
	// the other fails here — that's the point.
	const { buildAgentCompleteRow } = loadMisc(null, []);
	const names = ["Worker", "Researcher: find flaky tests", "Agent"];
	const successes: Array<boolean | undefined> = [true, false, undefined];
	const results = ["STATUS: green", "line one\n\nline two — ünïcode ✔", ""];

	it("agrees for every name × success × result combination (empty result → null on both sides)", () => {
		for (const name of names) {
			for (const success of successes) {
				for (const result of results) {
					const client = buildAgentCompleteRow({ name, agentId: "ag-9", success, result });
					const server = agentCompleteChatRow(name, success, result);
					expect(client).toBe(server);
				}
			}
		}
	});

	it("pins the canonical literal: **Agent <name> completed|failed:**\\n\\n<result>, no icon", () => {
		expect(agentCompleteChatRow("Worker", true, "STATUS: green")).toBe("**Agent Worker completed:**\n\nSTATUS: green");
		expect(agentCompleteChatRow("Worker", undefined, "x")).toBe("**Agent Worker completed:**\n\nx");
		expect(agentCompleteChatRow("Worker", false, "boom")).toBe("**Agent Worker failed:**\n\nboom");
		expect(agentCompleteChatRow("Worker", true, "")).toBeNull();
	});
});

describe("desktop notification (chat-ws-handler.js dispatchChatWsNonEvent)", () => {
	it("is suppressed for orchestrator children", () => {
		const active = chat("chat-a");
		const h = loadHandler(active, [active]);
		h.dispatchChatWsNonEvent(done({ parentAgentId: "orch-1", sessionId: "chat-a" }));
		expect(h.showNotification).not.toHaveBeenCalled();
		expect(h.addMessageEl).not.toHaveBeenCalled();
	});

	it('is suppressed for a spawn with no parent session (sessionId "")', () => {
		const active = chat("chat-a");
		const h = loadHandler(active, [active]);
		h.dispatchChatWsNonEvent(done({ parentAgentId: null, sessionId: "" }));
		expect(h.showNotification).not.toHaveBeenCalled();
		expect(h.addMessageEl).not.toHaveBeenCalled();
	});

	it("still fires for a chat-initiated spawn, whichever chat it belongs to", () => {
		const active = chat("chat-a");
		const h = loadHandler(active, [active, chat("chat-b")]);
		h.dispatchChatWsNonEvent(done({ parentAgentId: null, sessionId: "chat-b" }));
		expect(h.showNotification).toHaveBeenCalledTimes(1);
		expect(h.showNotification).toHaveBeenCalledWith("Agent Finished", "STATUS: green");
	});
});
