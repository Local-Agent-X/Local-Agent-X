/**
 * The four hazards the in-app `emulate` rework shipped with (chunk P9). Each
 * case here went RED against the code as landed in 6b75fd2e.
 *
 *   F1  A wedge in the emulated context tore down the USER'S in-app view:
 *       resetWedgedBrowser branched on the inAppBackends map, which emulation
 *       deliberately leaves populated, so it aborted the user's in-flight load
 *       and closed their tabs while never recovering the actual wedge.
 *   F2  `emulate` closed a real, non-emulated external Chrome (the session's
 *       no-desktop-bridge fallback) and reported "the in-app view was unchanged
 *       throughout".
 *   F3  closeAllBrowsers cleared every backend map but not the emulation
 *       profile, stranding the session id on a headless phone context.
 *   F6  M2 (secret ops follow the emulation override) and M5 (profile is set
 *       BEFORE the context is dropped) — two surviving mutants.
 *
 * Mock surface is the same as instance-routing.test.ts: config, desktop-bridge
 * and the shared-Chrome runtime. Nothing here launches a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LAXConfig } from "./../types/lax-config.js";
import type { BrowserBackend } from "./backend.js";

const state = vi.hoisted(() => ({ browserMode: "in-app" as string, bridge: true }));

vi.mock("../config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config.js")>();
	return { ...original, getRuntimeConfig: () => ({ browserMode: state.browserMode } as unknown as LAXConfig) };
});

vi.mock("../desktop-bridge.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../desktop-bridge.js")>();
	return { ...original, desktopBridgeAvailable: () => state.bridge };
});

const runtimeMocks = vi.hoisted(() => ({
	closeSharedBrowser: vi.fn(async () => undefined),
	forceKillSharedBrowser: vi.fn(),
}));

vi.mock("./runtime.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./runtime.js")>();
	return { ...original, ...runtimeMocks };
});

// M5 needs the ORDER of two calls emulate.ts makes, so both are wrapped
// record-and-delegate. Every other behaviour stays real.
const order = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("./emulation.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./emulation.js")>();
	return {
		...original,
		setSessionEmulation: (...args: Parameters<typeof original.setSessionEmulation>) => {
			order.calls.push("set-profile");
			return original.setSessionEmulation(...args);
		},
	};
});

vi.mock("./instance.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./instance.js")>();
	return {
		...original,
		releaseEmulatedBrowser: async (...args: Parameters<typeof original.releaseEmulatedBrowser>) => {
			order.calls.push("release-context");
			return original.releaseEmulatedBrowser(...args);
		},
	};
});

import {
	closeAllBrowsers,
	getBrowserManager,
	getCdpBrowserManager,
	getSecretBrowserOps,
	hasNonEmulatedCdpBrowser,
	releaseEmulatedBrowser,
	resetWedgedBrowser,
	_setBrowserRoutePlatformForTest,
} from "./instance.js";
import { BrowserManager } from "./manager.js";
import { ElectronInAppBackend } from "./in-app-backend.js";
import { EMULATION_PRESETS, getSessionEmulation, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";
import { handleEmulate } from "../tools/browser-tools/emulate.js";
import { BROWSER_TOOL_DESCRIPTION } from "../tools/browser-tools/description.js";

const SESSION = "chat-1";
const IPHONE = EMULATION_PRESETS.iphone;

/** Enough BrowserBackend for the emulate handler: it reads the current URL. */
const stubBackend = (url = ""): BrowserBackend => ({ getCurrentUrl: () => url } as unknown as BrowserBackend);

beforeEach(() => {
	vi.clearAllMocks();
	order.calls.length = 0;
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

describe("F1 — a wedge while emulating must not tear down the user's in-app view", () => {
	it("takes the CDP arm and never touches the in-app backend", async () => {
		const inApp = getBrowserManager(SESSION) as ElectronInAppBackend;
		expect(inApp).toBeInstanceOf(ElectronInAppBackend);
		// recoverFromWedge is the whole in-app teardown path: it aborts the
		// user's in-flight load and, on a failed ping, closes every owned tab.
		const recover = vi.spyOn(inApp, "recoverFromWedge");
		const closed = vi.spyOn(inApp, "close");

		setSessionEmulation(SESSION, IPHONE);
		const emulated = getBrowserManager(SESSION) as BrowserManager;
		expect(emulated).toBeInstanceOf(BrowserManager);
		const reset = vi.spyOn(emulated, "resetRuntime");

		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("cdp-reset");

		expect(recover).not.toHaveBeenCalled();
		expect(closed).not.toHaveBeenCalled();
		// …and the wedge that actually happened WAS recovered.
		expect(reset).toHaveBeenCalledOnce();
	});

	it("still recovers the in-app view in place when the session is NOT emulating", async () => {
		const inApp = getBrowserManager(SESSION) as ElectronInAppBackend;
		vi.spyOn(inApp, "recoverFromWedge").mockResolvedValue(true);
		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("recovered-in-place");
	});

	it("hands the SAME in-app backend back once emulation is cleared after a wedge", async () => {
		const inApp = getBrowserManager(SESSION);
		setSessionEmulation(SESSION, IPHONE);
		getBrowserManager(SESSION);
		await resetWedgedBrowser(SESSION);
		setSessionEmulation(SESSION, null);
		expect(getBrowserManager(SESSION)).toBe(inApp);
	});
});

describe("F2 — emulate must not close a real, non-emulated CDP browser", () => {
	/** The reachable sequence: bridge flaps down, the session falls back to a
	 *  real external Chrome, the bridge comes back, the agent calls emulate. */
	const bridgeFlapFallback = (): BrowserManager => {
		state.bridge = false;
		const fallback = getBrowserManager(SESSION) as BrowserManager;
		expect(fallback).toBeInstanceOf(BrowserManager);
		state.bridge = true;
		return fallback;
	};

	it("releaseEmulatedBrowser is a no-op on a browser it did not mint", async () => {
		const fallback = bridgeFlapFallback();
		const closed = vi.spyOn(fallback, "close");

		await releaseEmulatedBrowser(SESSION);

		expect(closed).not.toHaveBeenCalled();
		expect(hasNonEmulatedCdpBrowser(SESSION)).toBe(true);
	});

	it("emulate refuses instead of closing it, and names the way forward", async () => {
		const fallback = bridgeFlapFallback();
		const closed = vi.spyOn(fallback, "close");

		const result = await handleEmulate(stubBackend("https://example.com/"), { device: "iphone" }, SESSION);

		expect(result.isError).toBe(true);
		expect(String(result.content)).toContain("external Chrome it fell back to earlier");
		expect(String(result.content)).toContain('browser {action:"close"}');
		expect(closed).not.toHaveBeenCalled();
		// No half-installed state: the profile was never written.
		expect(getSessionEmulation(SESSION)).toBeUndefined();
	});

	it("still closes the context it DID mint (the way back keeps working)", async () => {
		setSessionEmulation(SESSION, IPHONE);
		const emulated = getBrowserManager(SESSION) as BrowserManager;
		const closed = vi.spyOn(emulated, "close");

		setSessionEmulation(SESSION, null);
		await releaseEmulatedBrowser(SESSION);

		expect(closed).toHaveBeenCalledOnce();
		expect(getBrowserManager(SESSION)).toBeInstanceOf(ElectronInAppBackend);
	});
});

describe("F3 — closeAllBrowsers clears the emulation profile", () => {
	it("does not leave a session stranded on a headless phone context", async () => {
		setSessionEmulation(SESSION, IPHONE);
		getBrowserManager(SESSION);
		expect(getSessionEmulation(SESSION)).toBeDefined();

		await closeAllBrowsers();

		expect(getSessionEmulation(SESSION)).toBeUndefined();
		// …and the session goes back to the browser the user can see.
		expect(getBrowserManager(SESSION)).toBeInstanceOf(ElectronInAppBackend);
	});
});

describe("F4 — the two things the result used to leave unsaid", () => {
	it("says the [user tab] rows and switch_tab escape hatch are gone, and that the context is logged out", async () => {
		const text = String((await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION)).content);
		expect(text).toContain("[user tab]");
		expect(text).toContain("switch_tab");
		expect(text).toContain("LOGGED OUT");
		// …and the two things M2 exposed: secret ops go to the emulated context,
		// and a credential filled there does not survive the next reset.
		expect(text).toContain("secret fill/capture tools");
		expect(text).toContain("discarded with it");
		// F7: the headless promise is stated as conditional, not absolute.
		expect(text).toContain("headless unless");
	});

	it("says the same two things in the tool description", () => {
		expect(BROWSER_TOOL_DESCRIPTION).toContain("[user tab] rows disappear");
		expect(BROWSER_TOOL_DESCRIPTION).toContain("renders LOGGED OUT");
	});
});

describe("F6 — the surviving mutants", () => {
	it("M2: secret ops follow the emulation override, not the raw route", () => {
		const inAppOps = vi.spyOn(ElectronInAppBackend.prototype, "secretOps");
		setSessionEmulation(SESSION, IPHONE);

		const ops = getSecretBrowserOps(SESSION);

		expect(ops).toBeDefined();
		// Reverting getSecretBrowserOps to resolveBrowserRoute() sends the fill
		// to the user's real, logged-in in-app view while the agent believes it
		// is typing into the private emulated context.
		expect(inAppOps).not.toHaveBeenCalled();
		expect(getCdpBrowserManager(SESSION)).toBeInstanceOf(BrowserManager);
		inAppOps.mockRestore();
	});

	it("M5: the profile is installed BEFORE the emulated context is dropped", async () => {
		await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION);
		expect(order.calls).toEqual(["set-profile", "release-context"]);
	});

	it("M5: the same order holds on the way back out", async () => {
		setSessionEmulation(SESSION, IPHONE);
		getBrowserManager(SESSION);
		order.calls.length = 0;

		await handleEmulate(stubBackend(""), { device: "desktop" }, SESSION);

		expect(order.calls).toEqual(["set-profile", "release-context"]);
		expect(getSessionEmulation(SESSION)).toBeUndefined();
	});
});
