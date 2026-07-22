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

// Capture what the routing seam says. createLogger is mocked wholesale, so
// sibling modules' loggers land here too — assertions filter on the
// [browser-route] tag rather than trusting the array to hold only our lines.
const logs = vi.hoisted(() => ({ debug: [] as string[], info: [] as string[], warn: [] as string[] }));

vi.mock("../logger.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../logger.js")>();
	const sink = {
		debug: (m: string) => { logs.debug.push(m); },
		info: (m: string) => { logs.info.push(m); },
		warn: (m: string) => { logs.warn.push(m); },
		error: () => {},
		child: () => sink,
	};
	return { ...original, createLogger: () => sink };
});

const routeLines = (level: "debug" | "info" | "warn") =>
	logs[level].filter((m) => m.includes("[browser-route]"));

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
	resolveBrowserBackendKind,
	resolveBrowserRoute,
	getSecretBrowserOps,
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
	logs.debug.length = 0;
	logs.info.length = 0;
	logs.warn.length = 0;
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

// The explicit fallback matrix (F1): resolveBrowserBackendKind() is "in-app"
// ONLY when mode=in-app AND not headless AND the bridge is up; ANY other cell
// falls to CDP. The CDP arm then binds the manager to the session's profile
// (whose userDataDir is threaded into launchViaCDP — proven in
// runtime-profile-dir / manager-profile-dir tests), so every fallback path
// carries the right profile identity.
describe("resolveBrowserBackendKind — fallback matrix", () => {
	it("in-app when mode=in-app + windowed + bridge up", () => {
		setInApp();
		expect(resolveBrowserBackendKind()).toBe("in-app");
	});

	it("cdp when the browserMode is not in-app (even with a bridge)", () => {
		state.browserMode = "continuity";
		state.bridge = true;
		expect(resolveBrowserBackendKind()).toBe("cdp");
	});

	it("cdp when running headless (LAX_BROWSER_HEADLESS=1)", () => {
		setInApp();
		process.env.LAX_BROWSER_HEADLESS = "1";
		expect(resolveBrowserBackendKind()).toBe("cdp");
	});

	it("cdp when the desktop bridge is absent", () => {
		setInApp(false);
		expect(resolveBrowserBackendKind()).toBe("cdp");
	});

	it("each cdp-fallback cell routes getBrowserManager to a profile-bound BrowserManager", () => {
		state.profiles.set("agent-run", "work-profile");
		// non-in-app mode
		state.browserMode = "isolated";
		state.bridge = true;
		const m1 = getBrowserManager("agent-run");
		expect(m1).toBeInstanceOf(BrowserManager);
		expect(m1.getProfileId()).toBe("work-profile");
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

describe("resolveBrowserRoute reasons", () => {
	it("names each arm of the fallback matrix", () => {
		state.browserMode = "continuity";
		expect(resolveBrowserRoute()).toEqual({ kind: "cdp", reason: "mode-not-in-app" });

		setInApp();
		process.env.LAX_BROWSER_HEADLESS = "1";
		expect(resolveBrowserRoute()).toEqual({ kind: "cdp", reason: "headless" });

		delete process.env.LAX_BROWSER_HEADLESS;
		setInApp(false);
		expect(resolveBrowserRoute()).toEqual({ kind: "cdp", reason: "no-desktop-bridge" });

		setInApp();
		expect(resolveBrowserRoute()).toEqual({ kind: "in-app", reason: "in-app" });
	});

	it("reports an explicit non-in-app mode ahead of any environment reason", () => {
		// A user who picked external Chrome must be told THAT, not that some
		// bridge was missing — otherwise the message sends them debugging the
		// wrong thing.
		state.browserMode = "continuity";
		state.bridge = false;
		process.env.LAX_BROWSER_HEADLESS = "1";
		expect(resolveBrowserRoute().reason).toBe("mode-not-in-app");
	});

	it("keeps resolveBrowserBackendKind as the sign of the route", () => {
		setInApp();
		expect(resolveBrowserBackendKind()).toBe("in-app");
		state.browserMode = "isolated";
		expect(resolveBrowserBackendKind()).toBe("cdp");
	});
});

describe("browser route reporting", () => {
	it("warns when a session wanted in-app and silently got Chrome", () => {
		setInApp(false);
		getBrowserManager("chat-1");
		expect(routeLines("warn")).toHaveLength(1);
		expect(routeLines("warn")[0]).toContain("desktop bridge is unavailable");
		expect(routeLines("warn")[0]).toContain("chat-1");
	});

	it("explains a config-selected external Chrome, naming the mode", () => {
		// The exact case a user hits when an old browserMode is on disk: the
		// answer to "why is Chrome opening?" must be in the log.
		state.browserMode = "continuity";
		getBrowserManager("chat-1");
		expect(routeLines("info")).toHaveLength(1);
		expect(routeLines("info")[0]).toContain('browserMode="continuity"');
		expect(routeLines("warn")).toHaveLength(0);
	});

	it("treats a headless run as expected, not a warning", () => {
		setInApp();
		process.env.LAX_BROWSER_HEADLESS = "1";
		getBrowserManager("chat-1");
		expect(routeLines("info")[0]).toContain("LAX_BROWSER_HEADLESS=1");
		expect(routeLines("warn")).toHaveLength(0);
	});

	it("reports once per session, never per call", () => {
		// getBrowserManager is on the tool hot path — a per-call line would
		// flood server.log on any real browsing session.
		setInApp(false);
		for (let i = 0; i < 5; i++) getBrowserManager("chat-1");
		expect(routeLines("warn")).toHaveLength(1);
	});

	it("reports each session separately", () => {
		setInApp(false);
		getBrowserManager("chat-1");
		getBrowserManager("chat-2");
		expect(routeLines("warn")).toHaveLength(2);
	});

	it("speaks again when a session's answer changes mid-flight", () => {
		setInApp(false);
		getBrowserManager("chat-1");
		expect(routeLines("warn")).toHaveLength(1);
		state.bridge = true;
		getBrowserManager("chat-1");
		expect(routeLines("debug").some((m) => m.includes("embedded in-app browser"))).toBe(true);
	});

	it("re-reports a session that was closed and reopened", async () => {
		setInApp(false);
		getBrowserManager("chat-1");
		await closeBrowser("chat-1");
		getBrowserManager("chat-1");
		expect(routeLines("warn")).toHaveLength(2);
	});
});

describe("getSecretBrowserOps", () => {
	// The whole point of the port: saved-password logins must work on the
	// DEFAULT backend. Before this, an in-app session threw CdpOnlyOperationError
	// and the user had to leave in-app mode to use secrets at all.
	it("serves an in-app session instead of refusing it", () => {
		setInApp();
		const ops = getSecretBrowserOps("chat-1");
		expect(ops).toBeDefined();
		expect(typeof ops.fillValue).toBe("function");
	});

	it("serves a CDP session through the same contract", () => {
		state.browserMode = "continuity";
		const ops = getSecretBrowserOps("chat-1");
		expect(ops).toBeDefined();
		expect(typeof ops.fillValue).toBe("function");
	});

	it("binds to the session's own backend, not a second browser identity", () => {
		setInApp();
		getSecretBrowserOps("chat-1");
		// No CDP manager may be conjured for an in-app session — that would open a
		// separate Chrome beside the live view, with a different login state.
		expect(() => getCdpBrowserManager("chat-1")).toThrow(CdpOnlyOperationError);
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
		expect(() => getCdpBrowserManager("chat-1")).toThrow(/has no Playwright page/);
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
	it("KEEPS a wedged in-app backend (recoverable) and never force-kills shared Chrome", async () => {
		setInApp();
		const first = getBrowserManager("chat-1");
		// No live view to ping in this env → the teardown arm. The backend
		// SURVIVES in the map so its preserved URL can reload on the next
		// action; full recovery behavior is pinned in wedge-recovery.test.ts.
		await expect(resetWedgedBrowser("chat-1")).resolves.toBe("view-recreated");
		expect(getBrowserManager("chat-1")).toBe(first);
		expect(runtimeMocks.forceKillSharedBrowser).not.toHaveBeenCalled();
	});

	it("force-kills the shared Chrome on the CDP path", async () => {
		const first = getBrowserManager("chat-1");
		await expect(resetWedgedBrowser("chat-1")).resolves.toBe("cdp-reset");
		expect(getBrowserManager("chat-1")).not.toBe(first);
		expect(runtimeMocks.forceKillSharedBrowser).toHaveBeenCalledOnce();
	});
});
