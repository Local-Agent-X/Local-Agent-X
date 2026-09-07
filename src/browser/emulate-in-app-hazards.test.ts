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
	closeBrowser,
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
		const emulatedClose = vi.spyOn(emulated, "close").mockResolvedValue(undefined);

		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("emulated-context-reset");

		expect(recover).not.toHaveBeenCalled();
		expect(closed).not.toHaveBeenCalled();
		// …and the wedge that actually happened WAS recovered: the emulated
		// context was dropped and the next access mints a fresh one.
		expect(emulatedClose).toHaveBeenCalledOnce();
		expect(getBrowserManager(SESSION)).not.toBe(emulated);
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

	// P11-F2: the escape it prescribes is closeBrowser, which closes BOTH kinds
	// of backend at the key. Following the refusal literally on a session that
	// also has an in-app view destroys the user's window and every tab in it —
	// exactly what this refusal exists to protect. There is no narrower action,
	// so the cost is stated, and stated from the session's actual state.
	it("names what browser {action:\"close\"} costs — and reads the cost off the session", async () => {
		// (a) an in-app view exists first, then the bridge flaps and it falls back.
		getBrowserManager(SESSION);
		bridgeFlapFallback();

		const withView = String((await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION)).content);
		expect(withView).toContain("it closes BOTH browsers this session has");
		expect(withView).toContain("in-app view the user is looking at, with every tab in it");

		await closeAllBrowsers();
		_resetSessionEmulationForTest();

		// (b) no in-app view was ever created: closing costs the user nothing,
		// and saying it would is the same kind of false statement in reverse.
		bridgeFlapFallback();
		const withoutView = String((await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION)).content);
		expect(withoutView).toContain("no in-app view open at the moment");
		expect(withoutView).not.toContain("it closes BOTH browsers this session has");
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

/**
 * P11-F3 — the F1 fix above opened a NEW cross-session teardown. Sending an
 * emulated wedge down the CDP arm reached BrowserManager.resetRuntime →
 * forceKillSharedBrowser, and there is exactly ONE shared Chrome process: a
 * concurrent chat that had fallen back to a real external Chrome lost its tabs
 * and logins because a DIFFERENT chat's private emulated page hung. The author's
 * F1 test could not see it — it mocked forceKillSharedBrowser and asserted only
 * that resetRuntime was called.
 */
describe("P11-F3 — an emulated wedge must not kill the one shared Chrome", () => {
	it("drops only that context; a peer session's real fallback browser survives", async () => {
		// chat-2 fell back to a REAL external Chrome while the bridge was down:
		// its tabs, its logins, a visible window.
		state.bridge = false;
		const peer = getBrowserManager("chat-2") as BrowserManager;
		expect(peer).toBeInstanceOf(BrowserManager);
		state.bridge = true;
		const peerClosed = vi.spyOn(peer, "close");
		const peerReset = vi.spyOn(peer, "resetRuntime");

		// chat-1 emulates on the in-app route and its emulated page hangs.
		setSessionEmulation(SESSION, IPHONE);
		const emulated = getBrowserManager(SESSION) as BrowserManager;
		const ownReset = vi.spyOn(emulated, "resetRuntime");
		vi.spyOn(emulated, "close").mockResolvedValue(undefined);

		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("emulated-context-reset");

		// The shared process — and with it chat-2's tabs — is untouched.
		expect(runtimeMocks.forceKillSharedBrowser).not.toHaveBeenCalled();
		expect(ownReset).not.toHaveBeenCalled();
		expect(peerReset).not.toHaveBeenCalled();
		expect(peerClosed).not.toHaveBeenCalled();
		// (getBrowserManager("chat-2") is not re-read here: the bridge is back up,
		// so it would now route chat-2 in-app. hasNonEmulatedCdpBrowser reads the
		// cdpManagers map directly, which is the thing that must have survived.)
		expect(hasNonEmulatedCdpBrowser("chat-2")).toBe(true);
	});

	it("a NON-emulated wedge still takes the process-wide reset", async () => {
		state.bridge = false;
		const fallback = getBrowserManager(SESSION) as BrowserManager;
		state.bridge = true;
		const reset = vi.spyOn(fallback, "resetRuntime").mockResolvedValue(undefined);

		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("cdp-reset");

		expect(reset).toHaveBeenCalledOnce();
	});
});

/**
 * P11-F8 — the emulatedCdpKeys invariant. Every site that removes a key from
 * cdpManagers must also clear it from emulatedCdpKeys; all five do today, but
 * deleting the clear from closeBrowser left the whole suite green. Violating it
 * re-opens F2: a REAL fallback browser minted later at a stale-emulated key
 * reads as the emulated stand-in, and releaseEmulatedBrowser closes it.
 */
describe("P11-F8 — a key removed from cdpManagers is removed from emulatedCdpKeys", () => {
	/** Bridge down at the same key: a real external Chrome with the user's tabs. */
	const mintRealFallback = (): BrowserManager => {
		state.bridge = false;
		const fallback = getBrowserManager(SESSION) as BrowserManager;
		state.bridge = true;
		expect(fallback).toBeInstanceOf(BrowserManager);
		return fallback;
	};

	const expectNotReleasableAsEmulated = async (fallback: BrowserManager): Promise<void> => {
		expect(hasNonEmulatedCdpBrowser(SESSION)).toBe(true);
		const closed = vi.spyOn(fallback, "close");
		await releaseEmulatedBrowser(SESSION);
		expect(closed).not.toHaveBeenCalled();
		// Still in cdpManagers, still flagged non-emulated: the stale key would
		// have flipped both of these.
		expect(hasNonEmulatedCdpBrowser(SESSION)).toBe(true);
	};

	it("closeBrowser clears it", async () => {
		setSessionEmulation(SESSION, IPHONE);
		getBrowserManager(SESSION); // mints the emulated stand-in at the key

		await closeBrowser(SESSION);

		await expectNotReleasableAsEmulated(mintRealFallback());
	});

	it("resetWedgedBrowser's emulated arm clears it", async () => {
		setSessionEmulation(SESSION, IPHONE);
		const emulated = getBrowserManager(SESSION) as BrowserManager;
		vi.spyOn(emulated, "close").mockResolvedValue(undefined);

		await resetWedgedBrowser(SESSION);
		setSessionEmulation(SESSION, null);

		await expectNotReleasableAsEmulated(mintRealFallback());
	});
});

/**
 * P11-F6/F7 — the result must report what happened, not what the arm is for.
 * device='desktop' announced a teardown and a restoration on a session that was
 * never emulating, and the emulating arm said the user's window was "still open
 * in front of them" on a session that has no in-app view at all.
 */
describe("P11-F6/F7 — the result reports the state it actually found", () => {
	const clearText = async (): Promise<string> =>
		String((await handleEmulate(stubBackend(""), { device: "desktop" }, SESSION)).content);

	it("device='desktop' on a session that was never emulating says nothing was closed", async () => {
		const text = await clearText();

		expect(text).toContain("Nothing to clear");
		expect(text).toContain("this call changed nothing");
		expect(text).not.toContain("emulated context is closed");
	});

	it("device='desktop' after a real emulated context says the context was closed", async () => {
		await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION);
		getBrowserManager(SESSION); // mints the emulated context

		const text = await clearText();

		expect(text).toContain("the private emulated context is closed");
		expect(text).toContain("This session is on the in-app browser view");
		expect(text).not.toContain("Nothing to clear");
	});

	it("device='desktop' with a profile but no context minted says exactly that", async () => {
		await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION);

		const text = await clearText();

		expect(text).toContain("No emulated context had been minted");
		expect(text).not.toContain("the private emulated context is closed");
		expect(text).not.toContain("Nothing to clear");
	});

	it("device='desktop' with a leftover fallback does NOT report a clean return to the in-app view", async () => {
		state.bridge = false;
		getBrowserManager(SESSION);
		state.bridge = true;

		const text = await clearText();

		expect(text).toContain("This session is NOT on the in-app view");
		expect(text).toContain("It also still blocks emulate");
		expect(text).not.toContain("This session is on the in-app browser view");
	});

	it("the emulating result claims a user window only when one exists", async () => {
		const noView = String((await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION)).content);
		expect(noView).toContain("no in-app browser view open right now");
		expect(noView).not.toContain("was not touched by this call");

		await handleEmulate(stubBackend(""), { device: "desktop" }, SESSION);
		getBrowserManager(SESSION); // now there IS an ElectronInAppBackend

		const withView = String((await handleEmulate(stubBackend(""), { device: "iphone" }, SESSION)).content);
		expect(withView).toContain("in-app browser view was not touched by this call");
		expect(withView).not.toContain("no in-app browser view open right now");
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
