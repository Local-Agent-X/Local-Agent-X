// F2: browserMode gained an "in-app" value (embedded WebContentsView backend).
// When a session that wanted in-app falls back to the CDP BrowserManager
// (headless/CI/no desktop bridge), the CDP runtime must interpret "in-app" as
// isolated (ephemeral per-session context) — NOT the advanced-shared else
// branch. This asserts acquireSessionContext handles the 4th enum value on the
// CDP path without an unhandled fallthrough, mapping it to isolated semantics.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext } from "playwright";

const mocks = vi.hoisted(() => {
	const contextIds: string[] = [];
	let nextId = 1;
	const cdpSend = vi.fn(async (method: string) => {
		if (method === "Target.getBrowserContexts") return { browserContextIds: [...contextIds] };
		return {};
	});
	const newContext = vi.fn(async () => {
		const id = `context-${nextId++}`;
		contextIds.push(id);
		return { id, pages: vi.fn(() => []), close: vi.fn(async () => undefined) } as unknown as BrowserContext;
	});
	const browser = {
		isConnected: () => true,
		contexts: () => [] as BrowserContext[],
		newContext,
		newBrowserCDPSession: vi.fn(async () => ({ send: cdpSend, detach: vi.fn(async () => undefined) })),
		close: vi.fn(async () => undefined),
	} as unknown as Browser;
	const launchViaCDP = vi.fn(async () => ({ browser, chromeProcess: null }));
	const startProxy = vi.fn(async () => ({ url: "http://127.0.0.1:41999" }));
	const closeProxy = vi.fn(async () => undefined);
	return { browser, contextIds, newContext, cdpSend, launchViaCDP, startProxy, closeProxy };
});

vi.mock("./egress-proxy.js", () => ({
	ensureBrowserEgressProxy: mocks.startProxy,
	closeBrowserEgressProxy: mocks.closeProxy,
}));

vi.mock("./launcher.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./launcher.js")>();
	return { ...original, launchViaCDP: mocks.launchViaCDP };
});

import { acquireSessionContext, releaseSessionContext, closeSharedBrowser } from "./runtime.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextIds.length = 0;
	mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:41999" });
});

afterEach(async () => { await closeSharedBrowser(); });

describe("runtime — in-app on the CDP fallback maps to isolated", () => {
	it("mints a fresh ephemeral context per session (isolated semantics), not a shared jar", async () => {
		const chat = await acquireSessionContext("chromium", "in-app", "chat");
		const mission = await acquireSessionContext("chromium", "in-app", "mission");
		// Two distinct contexts — the shared branch would have returned the same
		// cached context for both owners.
		expect(chat).not.toBe(mission);
		expect(mocks.newContext).toHaveBeenCalledTimes(2);
	});

	it("does not adopt the continuity single-owner cache for in-app", async () => {
		const first = await acquireSessionContext("chromium", "in-app", "chat");
		const second = await acquireSessionContext("chromium", "in-app", "chat");
		// Continuity would return the SAME context for the same owner; isolated
		// (and therefore in-app) mints a fresh one every acquire.
		expect(first).not.toBe(second);
	});

	it("releases an in-app CDP context by closing it (isolated release path)", async () => {
		const ctx = await acquireSessionContext("chromium", "in-app", "chat");
		await expect(releaseSessionContext(ctx, "in-app")).resolves.toBeUndefined();
		expect((ctx as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
	});
});
