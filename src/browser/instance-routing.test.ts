import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { LAXConfig } from "./../types/lax-config.js";

// Routing-seam contract (chunk A3): getBrowserManager routes a session to the
// in-app ElectronInAppBackend when browserMode selects it AND the run is not
// headless AND the desktop bridge is present; every other combination stays on
// the CDP BrowserManager. Availability is synchronous (mode + env + bridge
// flag) — no lifecycle ping is involved, so nothing here mocks bridge I/O.
//
// Module-level singleton state (the two backend maps) is cleaned between
// cases via closeAllBrowsers() — the same pattern instance.test.ts uses.

const state = vi.hoisted(() => ({
	browserMode: "isolated" as string,
	bridge: false,
	profiles: new Map<string, string>(),
}));

vi.mock("../config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config.js")>();
	return {
		...original,
		// Minimal config: the seam under test reads only browserMode.
		getRuntimeConfig: () => ({ browserMode: state.browserMode } as unknown as LAXConfig),
	};
});

vi.mock("../desktop-bridge.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../desktop-bridge.js")>();
	return { ...original, desktopBridgeAvailable: () => state.bridge };
});

vi.mock("./session-owner-registry.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./session-owner-registry.js")>();
	return {
		...original,
		resolveSessionBrowserProfileId: (sessionId: string) =>
			state.profiles.get(sessionId) ?? "default",
	};
});

const runtimeMocks = vi.hoisted(() => ({
	closeSharedBrowser: vi.fn(async () => undefined),
	forceKillSharedBrowser: vi.fn(),
}));

vi.mock("./runtime.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./runtime.js")>();
	return { ...original, ...runtimeMocks };
});

import {
	getBrowserManager,
	getCdpBrowserManager,
	closeBrowser,
	closeAllBrowsers,
	resetWedgedBrowser,
	inAppViewId,
	CdpOnlyOperationError,
} from "./instance.js";
import { BrowserManager } from "./manager.js";
import { ElectronInAppBackend } from "./in-app-backend.js";

function setInApp(bridge = true): void {
	state.browserMode = "in-app";
	state.bridge = bridge;
}

beforeEach(() => {
	state.browserMode = "isolated";
	state.bridge = false;
	state.profiles.clear();
	vi.clearAllMocks();
});

afterEach(async () => {
	delete process.env.LAX_BROWSER_HEADLESS;
	await closeAllBrowsers();
});

describe("getBrowserManager routing", () => {
	it("routes to ElectronInAppBackend when mode=in-app and the bridge is up", () => {
		setInApp();
		const backend = getBrowserManager("chat-1");
		expect(backend).toBeInstanceOf(ElectronInAppBackend);
	});

	it("caches one in-app backend per session", () => {
		setInApp();
		expect(getBrowserManager("chat-1")).toBe(getBrowserManager("chat-1"));
		expect(getBrowserManager("chat-1")).not.toBe(getBrowserManager("chat-2"));
	});

	it("falls back to the CDP BrowserManager when the bridge is absent", () => {
		setInApp(false);
		expect(getBrowserManager("chat-1")).toBeInstanceOf(BrowserManager);
	});

	it("stays on the CDP BrowserManager for non-in-app modes even with a bridge", () => {
		state.browserMode = "continuity";
		state.bridge = true;
		expect(getBrowserManager("chat-1")).toBeInstanceOf(BrowserManager);
	});

	it("stays on the CDP BrowserManager in headless runs even with mode+bridge", () => {
		setInApp();
		process.env.LAX_BROWSER_HEADLESS = "1";
		expect(getBrowserManager("chat-1")).toBeInstanceOf(BrowserManager);
	});

	it("binds the in-app backend to the session's registered profile", () => {
		setInApp();
		state.profiles.set("agent-run", "work-profile");
		const backend = getBrowserManager("agent-run");
		expect(backend.getProfileId()).toBe("work-profile");
	});
});

describe("inAppViewId determinism", () => {
	it("is deterministic per (session, profile)", () => {
		expect(inAppViewId("chat-1", "default")).toBe("view-chat-1-default");
		expect(inAppViewId("chat-1", "default")).toBe(inAppViewId("chat-1", "default"));
	});

	it("differs across profiles and across sessions", () => {
		expect(inAppViewId("chat-1", "p1")).not.toBe(inAppViewId("chat-1", "p2"));
		expect(inAppViewId("chat-1", "p1")).not.toBe(inAppViewId("chat-2", "p1"));
	});
});

describe("getCdpBrowserManager", () => {
	it("returns the concrete BrowserManager on the CDP path", () => {
		const manager = getCdpBrowserManager("chat-1");
		expect(manager).toBeInstanceOf(BrowserManager);
		expect(manager).toBe(getBrowserManager("chat-1"));
	});

	it("throws the typed CDP-only error for an in-app session", () => {
		setInApp();
		expect(() => getCdpBrowserManager("chat-1")).toThrow(CdpOnlyOperationError);
		expect(() => getCdpBrowserManager("chat-1")).toThrow(
			/secret-fill\/secret-capture require the CDP profile flow for now/,
		);
	});

	it("keeps throwing while a cached in-app backend exists even after a mode flip", () => {
		setInApp();
		getBrowserManager("chat-1"); // caches the in-app backend
		state.browserMode = "isolated";
		state.bridge = false;
		expect(() => getCdpBrowserManager("chat-1")).toThrow(CdpOnlyOperationError);
	});
});

describe("closeBrowser / closeAllBrowsers", () => {
	it("closes an in-app session so the next call gets a fresh backend", async () => {
		setInApp();
		const first = getBrowserManager("chat-1");
		await closeBrowser("chat-1");
		const second = getBrowserManager("chat-1");
		expect(first).toBeInstanceOf(ElectronInAppBackend);
		expect(second).not.toBe(first);
	});

	it("closes a CDP session and tears down the shared browser when none remain", async () => {
		const first = getBrowserManager("chat-1");
		await closeBrowser("chat-1");
		expect(getBrowserManager("chat-1")).not.toBe(first);
		expect(runtimeMocks.closeSharedBrowser).toHaveBeenCalled();
	});

	it("closeAllBrowsers clears both backend kinds", async () => {
		const cdp = getBrowserManager("cdp-session");
		setInApp();
		const inApp = getBrowserManager("in-app-session");
		await closeAllBrowsers();
		expect(getBrowserManager("in-app-session")).not.toBe(inApp);
		state.browserMode = "isolated";
		state.bridge = false;
		expect(getBrowserManager("cdp-session")).not.toBe(cdp);
	});
});

describe("resetWedgedBrowser", () => {
	it("drops a wedged in-app backend without force-killing shared Chrome", () => {
		setInApp();
		const first = getBrowserManager("chat-1");
		resetWedgedBrowser("chat-1");
		expect(getBrowserManager("chat-1")).not.toBe(first);
		expect(runtimeMocks.forceKillSharedBrowser).not.toHaveBeenCalled();
	});

	it("force-kills the shared Chrome on the CDP path", () => {
		const first = getBrowserManager("chat-1");
		resetWedgedBrowser("chat-1");
		expect(getBrowserManager("chat-1")).not.toBe(first);
		expect(runtimeMocks.forceKillSharedBrowser).toHaveBeenCalledOnce();
	});
});
