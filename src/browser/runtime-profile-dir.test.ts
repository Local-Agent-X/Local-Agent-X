// F1: the runtime threads the session's profile userDataDir all the way into
// launchViaCDP({ userDataDir }). Because there is ONE shared Chrome process, the
// first session to launch fixes the dir for concurrent CDP sessions — asserted
// here too (a later acquire with a different dir reuses the first browser).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext } from "playwright";

const mocks = vi.hoisted(() => {
	const contextIds: string[] = [];
	let nextId = 1;
	// getBrowserContexts must reflect the context newContext just added, so the
	// runtime's private-download configuration (added.length === 1) succeeds.
	const cdpSend = vi.fn(async (method: string) => {
		if (method === "Target.getBrowserContexts") return { browserContextIds: [...contextIds] };
		return {};
	});
	const browser = {
		isConnected: () => true,
		contexts: () => [] as BrowserContext[],
		newContext: vi.fn(async () => {
			contextIds.push(`context-${nextId++}`);
			return { id: Symbol("ctx"), pages: vi.fn(() => []), close: vi.fn(async () => undefined) } as unknown as BrowserContext;
		}),
		newBrowserCDPSession: vi.fn(async () => ({ send: cdpSend, detach: vi.fn(async () => undefined) })),
		close: vi.fn(async () => undefined),
	} as unknown as Browser;
	const launchViaCDP = vi.fn(async () => ({ browser, chromeProcess: null }));
	const startProxy = vi.fn(async () => ({ url: "http://127.0.0.1:41999" }));
	const closeProxy = vi.fn(async () => undefined);
	return { browser, contextIds, cdpSend, launchViaCDP, startProxy, closeProxy };
});

vi.mock("./egress-proxy.js", () => ({
	ensureBrowserEgressProxy: mocks.startProxy,
	closeBrowserEgressProxy: mocks.closeProxy,
}));

vi.mock("./launcher.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./launcher.js")>();
	return { ...original, launchViaCDP: mocks.launchViaCDP };
});

import { acquireSessionContext, closeSharedBrowser } from "./runtime.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:41999" });
});

afterEach(async () => { await closeSharedBrowser(); });

describe("runtime — profile userDataDir reaches launchViaCDP", () => {
	it("passes the session's profile dir as options.userDataDir", async () => {
		await acquireSessionContext("chromium", "isolated", "sess", "/lax/browser-profiles/work");
		expect(mocks.launchViaCDP).toHaveBeenCalledTimes(1);
		expect(mocks.launchViaCDP).toHaveBeenCalledWith(
			expect.anything(),
			"http://127.0.0.1:41999",
			{ userDataDir: "/lax/browser-profiles/work" },
		);
	});

	it("forwards undefined when no dir is supplied (launcher keeps its legacy default)", async () => {
		await acquireSessionContext("chromium", "isolated", "sess");
		expect(mocks.launchViaCDP).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			{ userDataDir: undefined },
		);
	});

	it("first-launcher-wins: a second session reuses the shared browser and does NOT relaunch", async () => {
		await acquireSessionContext("chromium", "isolated", "first", "/lax/chrome-profile");
		await acquireSessionContext("chromium", "isolated", "second", "/lax/browser-profiles/work");
		// One shared Chrome, one launch — the second dir is ignored by design.
		expect(mocks.launchViaCDP).toHaveBeenCalledTimes(1);
		expect(mocks.launchViaCDP).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			{ userDataDir: "/lax/chrome-profile" },
		);
	});
});
