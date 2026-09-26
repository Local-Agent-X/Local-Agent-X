import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, it, expect, beforeEach, vi } from "vitest";

let settings: Record<string, unknown> = {};
vi.mock("../../settings.js", () => ({ loadSettings: () => settings }));

let ops: Array<{ lane: string | null; state: string }> = [];
vi.mock("../../canonical-loop/index.js", () => ({ listActiveCanonicalOps: () => ops }));

const prewarmNewChat = vi.fn((_deps: unknown) => "started");
vi.mock("../../local-runtimes/prompt-prewarm.js", () => ({ prewarmNewChat: (deps: unknown) => prewarmNewChat(deps) }));

const jsonResponse = vi.fn();
vi.mock("../../server-utils.js", () => ({ jsonResponse: (...args: unknown[]) => jsonResponse(...args) }));

const { handlePrewarmRoute } = await import("./prewarm-route.js");

const req = {} as IncomingMessage;
const res = {} as ServerResponse;
const call = (method: string, path: string) => handlePrewarmRoute(method, new URL(`http://x${path}`), req, res);

describe("POST /api/chat/prewarm", () => {
	beforeEach(() => {
		settings = { provider: "local", model: "qwen3.6:27b" };
		ops = [];
		prewarmNewChat.mockClear();
		jsonResponse.mockClear();
	});

	it("answers 202 at once with the pre-warm's outcome, for the chat's current provider and model", async () => {
		expect(await call("POST", "/api/chat/prewarm")).toBe(true);
		expect(prewarmNewChat).toHaveBeenCalledWith({ current: { provider: "local", model: "qwen3.6:27b" }, foregroundBusy: false });
		expect(jsonResponse.mock.calls[0][1]).toBe(202);
		expect(jsonResponse.mock.calls[0][2]).toEqual({ outcome: "started" });
	});

	it("reports a running foreground turn as busy; background and paused work do not count", async () => {
		ops = [{ lane: "background", state: "running" }, { lane: "chat", state: "paused" }];
		await call("POST", "/api/chat/prewarm");
		expect(prewarmNewChat.mock.calls[0][0]).toMatchObject({ foregroundBusy: false });
		ops = [{ lane: "chat", state: "running" }];
		await call("POST", "/api/chat/prewarm");
		expect(prewarmNewChat.mock.calls[1][0]).toMatchObject({ foregroundBusy: true });
	});

	it("leaves every other path and method to the next handler", async () => {
		expect(await call("GET", "/api/chat/prewarm")).toBe(false);
		expect(await call("POST", "/api/chat")).toBe(false);
		expect(prewarmNewChat).not.toHaveBeenCalled();
	});
});
