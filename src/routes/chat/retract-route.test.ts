import type { IncomingMessage, ServerResponse } from "node:http";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { ServerContext } from "../../server-context.js";
import type { Session } from "../../types.js";

// ── mocks (real: retractLastTurn helper + validateBody/zod schema) ──
const hasActiveTurn = vi.fn((_id: string): boolean => false);
vi.mock("../../session/turn-lock.js", () => ({
	hasActiveTurn: (id: string) => hasActiveTurn(id),
}));

const broadcastToSession = vi.fn();
vi.mock("../../chat-ws/state.js", () => ({
	broadcastToSession: (...args: unknown[]) => broadcastToSession(...args),
}));

let body: unknown;
const jsonResponse = vi.fn();
vi.mock("../../server-utils.js", () => ({
	safeParseBody: vi.fn(async () => body),
	jsonResponse: (...args: unknown[]) => jsonResponse(...args),
}));

const { handleRetractRoute } = await import("./retract-route.js");

const user = (c: string): ChatCompletionMessageParam => ({ role: "user", content: c });
const asst = (c: string): ChatCompletionMessageParam => ({ role: "assistant", content: c });

const req = {} as IncomingMessage;
const res = {} as ServerResponse;

/** status + JSON body of the single jsonResponse(res, status, data, req) call. */
function lastReply(): { status: number; data: Record<string, unknown> } {
	const call = jsonResponse.mock.calls.at(-1)!;
	return { status: call[1] as number, data: call[2] as Record<string, unknown> };
}

let session: Session;
const save = vi.fn();
const flushSession = vi.fn(async () => {});
let ctx: ServerContext;

beforeEach(() => {
	vi.clearAllMocks();
	hasActiveTurn.mockReturnValue(false);
	session = {
		id: "s1",
		title: "t",
		messages: [user("hi"), asst("hello"), user("do X"), asst("did X")],
		createdAt: 1,
		updatedAt: 1,
	};
	ctx = {
		getOrCreateSession: () => session,
		flushSession,
		sessionStore: { save } as unknown as ServerContext["sessionStore"],
	} as unknown as ServerContext;
});

describe("handleRetractRoute", () => {
	it("ignores non-matching method/path", async () => {
		const handled = await handleRetractRoute("GET", new URL("http://x/api/retract"), req, res, ctx);
		expect(handled).toBe(false);
		expect(jsonResponse).not.toHaveBeenCalled();
	});

	it("happy path (turn mode): truncates, persists, broadcasts, acks", async () => {
		body = { sessionId: "s1", mode: "turn" };
		const handled = await handleRetractRoute("POST", new URL("http://x/api/retract"), req, res, ctx);
		expect(handled).toBe(true);
		expect(flushSession).toHaveBeenCalledWith("s1");
		expect(session.messages).toEqual([user("hi"), asst("hello")]);
		expect(save).toHaveBeenCalledWith(session);
		expect(broadcastToSession).toHaveBeenCalledWith("s1", { type: "history_changed", sessionId: "s1" });
		const { status, data } = lastReply();
		expect(status).toBe(200);
		expect(data).toMatchObject({ ok: true, mode: "turn", removed: 2, messageCount: 2 });
	});

	it("response mode keeps the last user row", async () => {
		body = { sessionId: "s1", mode: "response" };
		await handleRetractRoute("POST", new URL("http://x/api/retract"), req, res, ctx);
		expect(session.messages).toEqual([user("hi"), asst("hello"), user("do X")]);
		expect(lastReply().data).toMatchObject({ ok: true, mode: "response", removed: 1 });
	});

	it("REFUSES with 409 while a turn is active — no mutation, no broadcast (but still flushes first)", async () => {
		hasActiveTurn.mockReturnValue(true);
		body = { sessionId: "s1", mode: "turn" };
		const before = [...session.messages];
		await handleRetractRoute("POST", new URL("http://x/api/retract"), req, res, ctx);
		expect(flushSession).toHaveBeenCalledWith("s1");
		expect(session.messages).toEqual(before);
		expect(save).not.toHaveBeenCalled();
		expect(broadcastToSession).not.toHaveBeenCalled();
		const { status, data } = lastReply();
		expect(status).toBe(409);
		expect(data).toMatchObject({ ok: false });
	});

	it("acks ok:false and does not broadcast when there is nothing to retract", async () => {
		session.messages = [asst("orphan")];
		body = { sessionId: "s1", mode: "turn" };
		await handleRetractRoute("POST", new URL("http://x/api/retract"), req, res, ctx);
		expect(save).not.toHaveBeenCalled();
		expect(broadcastToSession).not.toHaveBeenCalled();
		expect(lastReply().data).toMatchObject({ ok: false, removed: 0 });
	});
});
