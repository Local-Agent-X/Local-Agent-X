/**
 * End-to-end for the in-app arm of `browser emulate`, from the routing seam
 * (instance.getBrowserManager) through the context runtime to an actual page
 * read — with only the chromium/Playwright boundary stubbed, the same way
 * emulation-lifecycle.test.ts and runtime-in-app-fallback.test.ts do it.
 *
 * What it pins:
 *   1. After emulate on the in-app route, the page a read runs on belongs to a
 *      context minted with the PHONE viewport and the PHONE user agent. Drop
 *      the profile in acquireSessionContext and this goes red.
 *   2. That context is minted in a private HEADLESS Chrome — the whole point is
 *      that it is not, and does not become, a window on the user's screen.
 *   3. The in-app backend is never driven and never closed while it happens,
 *      and it is the SAME backend handed back once emulation is cleared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { LAXConfig } from "./../types/lax-config.js";

const state = vi.hoisted(() => ({ browserMode: "in-app" as string, bridge: true }));

vi.mock("../config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config.js")>();
	return {
		...original,
		getRuntimeConfig: () => ({ browserMode: state.browserMode, browserIdleTimeoutMs: 600_000 } as unknown as LAXConfig),
	};
});

vi.mock("../desktop-bridge.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../desktop-bridge.js")>();
	return { ...original, desktopBridgeAvailable: () => state.bridge };
});

const mocks = vi.hoisted(() => {
	const contextIds: string[] = [];
	let nextId = 1;
	const cdpSend = vi.fn(async (method: string) => {
		if (method === "Target.getBrowserContexts") return { browserContextIds: [...contextIds] };
		return {};
	});
	// The fake page is only as capable as BrowserManager.getPage + evaluate
	// need: handler installs (on), timeouts, liveness (title/isClosed/url) and
	// the evaluate itself. `ownerContext` is the assertion hook — it says which
	// context this page, and therefore the read, actually came from.
	const makePage = (context: BrowserContext): Page => ({
		ownerContext: context,
		setDefaultTimeout: vi.fn(),
		on: vi.fn(),
		url: () => "about:blank",
		isClosed: () => false,
		title: vi.fn(async () => "Blank"),
		close: vi.fn(async () => undefined),
		evaluate: vi.fn(async () => "read-ok"),
	} as unknown as Page);
	const newContext = vi.fn(async (_options?: BrowserContextOptions) => {
		const id = `context-${nextId++}`;
		contextIds.push(id);
		const context = {
			id,
			pages: vi.fn(() => []),
			route: vi.fn(async () => undefined),
			on: vi.fn(),
			close: vi.fn(async () => undefined),
		} as unknown as BrowserContext;
		(context as unknown as { newPage: () => Promise<Page> }).newPage = vi.fn(async () => makePage(context));
		return context;
	});
	const browser = {
		isConnected: () => true,
		contexts: () => [] as BrowserContext[],
		newContext,
		newBrowserCDPSession: vi.fn(async () => ({ send: cdpSend, detach: vi.fn(async () => undefined) })),
		close: vi.fn(async () => undefined),
	} as unknown as Browser;
	const launchViaCDP = vi.fn(
		async (_pw: unknown, _proxyUrl: string, _options?: Record<string, unknown>) => ({ browser, chromeProcess: null }),
	);
	return { browser, contextIds, newContext, launchViaCDP };
});

vi.mock("./egress-proxy.js", () => ({
	ensureBrowserEgressProxy: vi.fn(async () => ({ url: "http://127.0.0.1:41999" })),
	closeBrowserEgressProxy: vi.fn(async () => undefined),
}));

vi.mock("./launcher.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./launcher.js")>();
	return { ...original, launchViaCDP: mocks.launchViaCDP };
});

import { USER_AGENTS } from "./launcher.js";
import { getBrowserManager, closeAllBrowsers, releaseEmulatedBrowser, _setBrowserRoutePlatformForTest } from "./instance.js";
import { BrowserManager } from "./manager.js";
import { ElectronInAppBackend } from "./in-app-backend.js";
import { EMULATION_PRESETS, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";

const SESSION = "chat-emulate";
const IPHONE = EMULATION_PRESETS.iphone;

/** The options the chromium boundary received for the Nth minted context. */
const mintedOptions = (nth: number): BrowserContextOptions =>
	mocks.newContext.mock.calls[nth][0] as BrowserContextOptions;

/** Which context the page a read ran on belongs to. */
const contextOfLastRead = (page: unknown): BrowserContext =>
	(page as { ownerContext: BrowserContext }).ownerContext;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextIds.length = 0;
	state.browserMode = "in-app";
	state.bridge = true;
	_setBrowserRoutePlatformForTest("darwin");
	_resetSessionEmulationForTest();
});

afterEach(async () => {
	_setBrowserRoutePlatformForTest(null);
	await closeAllBrowsers();
	_resetSessionEmulationForTest();
});

describe("emulate on the in-app route — the read sees the phone", () => {
	it("runs a page read in a context minted with the phone viewport AND user agent", async () => {
		// The session starts on the browser the user is looking at.
		expect(getBrowserManager(SESSION)).toBeInstanceOf(ElectronInAppBackend);

		// What the emulate handler does: install the profile.
		setSessionEmulation(SESSION, IPHONE);

		// What every SUBSEQUENT page action then does: ask for the session's
		// backend and read the page. evaluate is the layout_report path too —
		// layout_report evaluates a fixed script through this same page.
		const backend = getBrowserManager(SESSION);
		expect(backend).toBeInstanceOf(BrowserManager);
		await expect(backend.evaluate("document.documentElement.clientWidth")).resolves.toContain("read-ok");

		// The context that page came from carried the emulation verbatim.
		const page = await (backend as BrowserManager).getPage();
		const options = mintedOptions(0);
		expect(contextOfLastRead(page)).toBe(await mocks.newContext.mock.results[0].value);
		expect(options).toMatchObject({
			viewport: IPHONE.viewport,
			deviceScaleFactor: IPHONE.deviceScaleFactor,
			isMobile: true,
			hasTouch: true,
			userAgent: IPHONE.userAgent,
		});
		// Not the desktop defaults it would otherwise have got.
		expect(options.viewport).not.toEqual({ width: 1280, height: 800 });
		expect(options.userAgent).not.toBe(USER_AGENTS.chromium);
	});

	it("mints that context in a HEADLESS Chrome — no second window on the user's screen", async () => {
		setSessionEmulation(SESSION, IPHONE);

		await getBrowserManager(SESSION).evaluate("1");

		expect(mocks.launchViaCDP).toHaveBeenCalledOnce();
		expect(mocks.launchViaCDP.mock.calls[0][2]).toMatchObject({ headless: true });
	});

	it("never drives or closes the in-app view, and hands the same one back on the way out", async () => {
		const inApp = getBrowserManager(SESSION) as ElectronInAppBackend;
		const drove = vi.spyOn(inApp, "navigate");
		const closed = vi.spyOn(inApp, "close");

		setSessionEmulation(SESSION, IPHONE);
		await getBrowserManager(SESSION).evaluate("1");

		expect(drove).not.toHaveBeenCalled();
		expect(closed).not.toHaveBeenCalled();

		// THE WAY BACK: clear the profile, drop the private context.
		setSessionEmulation(SESSION, null);
		await releaseEmulatedBrowser(SESSION);

		expect(getBrowserManager(SESSION)).toBe(inApp);
		expect(closed).not.toHaveBeenCalled();
	});

	it("a session with NO profile keeps the desktop defaults on the same runtime", async () => {
		setSessionEmulation(SESSION, IPHONE);
		await getBrowserManager(SESSION).evaluate("1");

		// A different chat, no profile: stays on its in-app view entirely.
		expect(getBrowserManager("chat-other")).toBeInstanceOf(ElectronInAppBackend);
		expect(mocks.newContext).toHaveBeenCalledOnce();
	});
});
