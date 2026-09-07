// df8ca383: the runtime half of `browser.emulate`. emulate.test.ts pins the tool
// handler with browser/instance.js and browser/index.js mocked wholesale, so the
// REAL profile → context-creation → release → teardown chain was exercised by
// nothing. These tests run the real runtime.ts + instance.ts seams and stub
// only the Playwright/chromium boundary (launchViaCDP + the egress proxy), the
// same way runtime-in-app-fallback.test.ts and runtime-profile-dir.test.ts do.
//
// Three invariants the commit message lists as "Verified", each of which a
// one-line mutation used to survive:
//   G  acquireSessionContext applies the session's profile as CONTEXT-CREATION
//      options merged over the runtime defaults (drop the profile → emulate
//      becomes a no-op that just kills the context).
//   F  releaseSessionContext closes an emulated context whatever the mode says
//      (drop the early-close → an advanced-shared emulated context leaks).
//   E  closeBrowser clears the profile (drop it → a reused session id inherits
//      the previous session's phone viewport).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";

const mocks = vi.hoisted(() => {
	const contextIds: string[] = [];
	let nextId = 1;
	// getBrowserContexts must reflect the context newContext just added, so the
	// runtime's private-download configuration (added.length === 1) succeeds.
	const cdpSend = vi.fn(async (method: string) => {
		if (method === "Target.getBrowserContexts") return { browserContextIds: [...contextIds] };
		return {};
	});
	const newContext = vi.fn(async (_options?: BrowserContextOptions) => {
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

import { USER_AGENTS } from "./launcher.js";
import { acquireSessionContext, releaseSessionContext, closeSharedBrowser } from "./runtime.js";
import { closeBrowser } from "./instance.js";
import {
	EMULATION_PRESETS,
	getSessionEmulation,
	setSessionEmulation,
	_resetSessionEmulationForTest,
	type EmulationProfile,
} from "./emulation.js";

type StubContext = BrowserContext & { close: ReturnType<typeof vi.fn> };
const closeOf = (context: BrowserContext): StubContext["close"] => (context as StubContext).close;

/** The options the chromium boundary received for the Nth minted context. */
const mintedOptions = (nth: number): BrowserContextOptions =>
	mocks.newContext.mock.calls[nth][0] as BrowserContextOptions;

/** What a profile must have contributed to the context options, verbatim. */
const optionsFrom = (profile: EmulationProfile) => ({
	viewport: profile.viewport,
	deviceScaleFactor: profile.deviceScaleFactor,
	isMobile: profile.isMobile,
	hasTouch: profile.hasTouch,
	userAgent: profile.userAgent,
});

const DEFAULT_OPTS = {
	userAgent: USER_AGENTS.chromium,
	viewport: { width: 1280, height: 800 },
	locale: "en-US",
	timezoneId: "America/Chicago",
	acceptDownloads: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextIds.length = 0;
	mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:41999" });
	_resetSessionEmulationForTest();
});

afterEach(async () => {
	await closeSharedBrowser();
	_resetSessionEmulationForTest();
});

describe("emulation lifecycle — profile applied at context creation (G)", () => {
	it("mints the session's context with the profile merged over the runtime defaults", async () => {
		const profile = EMULATION_PRESETS.iphone;
		setSessionEmulation("chat", profile);

		await acquireSessionContext("chromium", "isolated", "chat");

		expect(mocks.newContext).toHaveBeenCalledTimes(1);
		const options = mintedOptions(0);
		// Every emulation field reached the chromium boundary verbatim …
		expect(options).toMatchObject(optionsFrom(profile));
		// … ON TOP of the defaults, not instead of them: the non-emulated
		// options (locale, timezone, downloads) must survive the merge, and the
		// default desktop viewport/UA must be the ones overridden.
		expect(options).toMatchObject({
			locale: DEFAULT_OPTS.locale,
			timezoneId: DEFAULT_OPTS.timezoneId,
			acceptDownloads: true,
		});
		expect(options.viewport).not.toEqual(DEFAULT_OPTS.viewport);
		expect(options.userAgent).not.toBe(DEFAULT_OPTS.userAgent);
	});

	it("mints a session WITHOUT a profile from the unmodified defaults", async () => {
		setSessionEmulation("other", EMULATION_PRESETS.android);

		await acquireSessionContext("chromium", "isolated", "chat");

		const options = mintedOptions(0);
		expect(options).toMatchObject(DEFAULT_OPTS);
		// Another session's profile must never bleed into this one.
		expect(options).not.toHaveProperty("isMobile");
		expect(options).not.toHaveProperty("hasTouch");
		expect(options).not.toHaveProperty("deviceScaleFactor");
	});
});

describe("emulation lifecycle — emulated contexts close on release in every mode (F)", () => {
	it("closes an advanced-shared session's emulated context on release", async () => {
		setSessionEmulation("chat", EMULATION_PRESETS.iphone);
		const context = await acquireSessionContext("chromium", "advanced-shared", "chat");

		await releaseSessionContext(context, "advanced-shared");

		// advanced-shared's non-emulated branch returns WITHOUT closing (the
		// shared jar outlives any one session); an emulated context is
		// session-private and must not be handed to that branch.
		expect(closeOf(context)).toHaveBeenCalledTimes(1);
	});

	it("leaves a NON-emulated advanced-shared context open (the shared jar survives)", async () => {
		const context = await acquireSessionContext("chromium", "advanced-shared", "chat");

		await releaseSessionContext(context, "advanced-shared");

		expect(closeOf(context)).not.toHaveBeenCalled();
		// And the jar is still the one handed out next time.
		expect(await acquireSessionContext("chromium", "advanced-shared", "mission")).toBe(context);
	});

	it("never hands an emulated context to a later advanced-shared acquire as the shared jar", async () => {
		setSessionEmulation("chat", EMULATION_PRESETS.iphone);
		const emulated = await acquireSessionContext("chromium", "advanced-shared", "chat");

		const shared = await acquireSessionContext("chromium", "advanced-shared", "mission");

		expect(shared).not.toBe(emulated);
		expect(mintedOptions(1)).toMatchObject(DEFAULT_OPTS);
		expect(mintedOptions(1)).not.toHaveProperty("isMobile");
	});
});

describe("emulation lifecycle — profile cleared on session teardown (E)", () => {
	it("closeBrowser drops the profile so a reused session id gets default options", async () => {
		setSessionEmulation("chat", EMULATION_PRESETS.android);
		expect(getSessionEmulation("chat")).toBeDefined();

		await closeBrowser("chat");

		expect(getSessionEmulation("chat")).toBeUndefined();
		// A later session reusing the same id must NOT inherit the phone viewport.
		await acquireSessionContext("chromium", "isolated", "chat");
		const options = mintedOptions(0);
		expect(options).toMatchObject(DEFAULT_OPTS);
		expect(options).not.toHaveProperty("isMobile");
		expect(options).not.toHaveProperty("hasTouch");
	});

	it("closeBrowser clears only the torn-down session's profile", async () => {
		setSessionEmulation("chat", EMULATION_PRESETS.android);
		setSessionEmulation("mission", EMULATION_PRESETS.ipad);

		await closeBrowser("chat");

		expect(getSessionEmulation("chat")).toBeUndefined();
		expect(getSessionEmulation("mission")).toBe(EMULATION_PRESETS.ipad);
	});
});

describe("emulation lifecycle — repeat emulate does not leak contexts", () => {
	it("closes the previous emulated context before minting the next one", async () => {
		// The emulate handler's real sequence per call: set profile → close the
		// session's context (BrowserManager.close → releaseSessionContext) → the
		// next page access re-acquires. Two calls must leave exactly ONE live
		// emulated context, the second one, with the first closed BEFORE the
		// second was minted.
		setSessionEmulation("chat", EMULATION_PRESETS.iphone);
		const first = await acquireSessionContext("chromium", "isolated", "chat");

		setSessionEmulation("chat", EMULATION_PRESETS.ipad);
		await releaseSessionContext(first, "isolated");
		const second = await acquireSessionContext("chromium", "isolated", "chat");

		expect(second).not.toBe(first);
		expect(closeOf(first)).toHaveBeenCalledTimes(1);
		expect(closeOf(second)).not.toHaveBeenCalled();
		const firstClosedAt = closeOf(first).mock.invocationCallOrder[0];
		const secondMintedAt = mocks.newContext.mock.invocationCallOrder[1];
		expect(firstClosedAt).toBeLessThan(secondMintedAt);
		// Each acquire carried ITS profile, not the previous one.
		expect(mintedOptions(0)).toMatchObject(optionsFrom(EMULATION_PRESETS.iphone));
		expect(mintedOptions(1)).toMatchObject(optionsFrom(EMULATION_PRESETS.ipad));
	});
});
