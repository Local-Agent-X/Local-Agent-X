import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	_setEmbeddedChromeIdentityOverrideForTest,
	buildEmbeddedChromeIdentity,
	ensureEmbeddedChromeIdentity,
	prepareEmbeddedChromeIdentityForNavigation,
	registerEmbeddedChromeIdentitySession,
	stableNativeBrowserUserAgent,
} from "./embedded-chrome-identity";

describe("embedded Chrome identity", () => {
	const originalChrome = Object.getOwnPropertyDescriptor(process.versions, "chrome");
	beforeAll(() => {
		_setEmbeddedChromeIdentityOverrideForTest(true);
		Object.defineProperty(process.versions, "chrome", {
			value: "150.0.7339.2",
			configurable: true,
		});
	});
	afterAll(() => {
		_setEmbeddedChromeIdentityOverrideForTest(false);
		if (originalChrome) Object.defineProperty(process.versions, "chrome", originalChrome);
		else delete (process.versions as { chrome?: string }).chrome;
	});

	it("builds coherent Windows UA and client hints from the Chromium version", () => {
		const identity = buildEmbeddedChromeIdentity("150.0.7339.2", "win32", "x64", "10.0.26100");
		expect(identity.userAgent).toContain("Chrome/150.0.7339.2");
		expect(identity.userAgent).not.toMatch(/Electron|Local Agent X/i);
		expect(identity.platform).toBe("Win32");
		expect(identity.userAgentMetadata).toMatchObject({
			fullVersion: "150.0.7339.2",
			platform: "Windows",
			platformVersion: "19.0.0",
			architecture: "x86",
			bitness: "64",
			mobile: false,
		});
		expect(identity.userAgentMetadata.brands).toContainEqual({ brand: "Google Chrome", version: "150" });
		expect(identity.userAgentMetadata.fullVersionList).toContainEqual({
			brand: "Google Chrome",
			version: "150.0.7339.2",
		});
	});

	it("attaches protocol 1.3 and applies matching UA metadata once", async () => {
		const sendCommand = vi.fn().mockResolvedValue({});
		const attach = vi.fn();
		const once = vi.fn();
		const contents = {
			isDestroyed: () => false,
			once,
			on: once,
			debugger: {
				isAttached: () => attach.mock.calls.length > 0,
				attach,
				sendCommand,
				on: once,
			},
		};
		const first = ensureEmbeddedChromeIdentity(contents as never);
		const second = ensureEmbeddedChromeIdentity(contents as never);
		await Promise.all([first, second]);
		expect(first).toBe(second);
		expect(attach).toHaveBeenCalledOnce();
		expect(attach).toHaveBeenCalledWith("1.3");
		expect(sendCommand).toHaveBeenCalledOnce();
		const [method, params] = sendCommand.mock.calls[0];
		expect(method).toBe("Emulation.setUserAgentOverride");
		expect(params.userAgent).toContain("Chrome/150.0.7339.2");
		expect(params.userAgent).not.toContain("Electron");
		expect(params.userAgentMetadata.fullVersion).toBe("150.0.7339.2");
	});

	it("does not let a stalled identity command block navigation", async () => {
		const once = vi.fn();
		const contents = {
			isDestroyed: () => false,
			once,
			on: once,
			debugger: {
				isAttached: () => true,
				attach: vi.fn(),
				sendCommand: vi.fn(() => new Promise(() => {})),
				on: once,
			},
		};
		const startedAt = Date.now();
		await prepareEmbeddedChromeIdentityForNavigation(contents as never, 10);
		expect(Date.now() - startedAt).toBeLessThan(500);
	});

	it("applies identity at creation to every web contents on the browser partition", async () => {
		let created: ((_event: unknown, contents: unknown) => void) | undefined;
		const app = { on: vi.fn((_name, listener) => { created = listener; }) };
		const browserSession = { setUserAgent: vi.fn() };
		registerEmbeddedChromeIdentitySession(app as never, browserSession as never);
		const sendCommand = vi.fn().mockResolvedValue({});
		const attach = vi.fn();
		const once = vi.fn();
		const contents = {
			session: browserSession,
			isDestroyed: () => false,
			once,
			on: once,
			debugger: {
				isAttached: () => attach.mock.calls.length > 0,
				attach,
				sendCommand,
				on: once,
			},
		};
		created?.({}, contents);
		await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledOnce());
		expect(browserSession.setUserAgent).toHaveBeenCalledWith(
			expect.stringContaining("Chrome/150.0.7339.2"),
			"en-US,en;q=0.9",
		);
		expect(app.on).toHaveBeenCalledWith("web-contents-created", expect.any(Function));
	});
});

// REGRESSION GUARD (2026-07-30). The session UA was applied here
// UNCONDITIONALLY while identityOverrideEnabled gated only the client-hint
// half. That is the worst combination: the UA claims plain Chrome while
// Sec-CH-UA still reports bare Chromium, Cloudflare cross-checks the two, and
// the in-app browser loops on the challenge forever. Measured by bisect: the
// native Chromium/Electron identity passes; a Chrome-only UA override is
// refused. Production only removes Electron's release-specific app token; it
// never claims Google Chrome or attaches the debugger to rewrite client hints.
describe("embedded Chrome identity — disabled (the production default)", () => {
	it("removes only the release-specific app token and installs no debugger hook", () => {
		_setEmbeddedChromeIdentityOverrideForTest(false);
		const browserSession = {
			getUserAgent: vi.fn(() => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) LocalAgentX/0.5.10 Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36"),
			setUserAgent: vi.fn(),
		} as unknown as Parameters<typeof registerEmbeddedChromeIdentitySession>[1];
		const app = {
			on: vi.fn(),
			userAgentFallback:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) LocalAgentX/0.5.10 Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36",
		} as unknown as Parameters<typeof registerEmbeddedChromeIdentitySession>[0];

		registerEmbeddedChromeIdentitySession(app, browserSession);

		expect(browserSession.setUserAgent).toHaveBeenCalledWith(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36",
		);
		// The app-wide fallback that favicons / service-worker / challenge-widget
		// requests use must be stripped to the SAME identity — otherwise those
		// requests leak the app token and Cloudflare loops (2026-08-01). The
		// Electron/ token stays so /Electron/i runtime detection is unaffected.
		expect(app.userAgentFallback).toBe(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36",
		);
		expect(app.userAgentFallback).not.toContain("LocalAgentX");
		expect(app.on).not.toHaveBeenCalled();
	});

	it("leaves an already-stable native Chromium/Electron UA unchanged", () => {
		const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36";
		expect(stableNativeBrowserUserAgent(ua)).toBe(ua);
	});

	it("does not strip unrelated version tokens outside Electron's app-token position", () => {
		const ua = "Mozilla/5.0 Version/18.0 AppleWebKit/537.36 (KHTML, like Gecko) LocalAgentX/0.5.10 Chrome/150.0.7339.2 Electron/43.2.0 Safari/537.36";
		expect(stableNativeBrowserUserAgent(ua)).toContain("Version/18.0");
		expect(stableNativeBrowserUserAgent(ua)).not.toContain("LocalAgentX/0.5.10");
	});

	it("leaves a web contents alone when one is created", async () => {
		_setEmbeddedChromeIdentityOverrideForTest(false);
		const attach = vi.fn();
		const sendCommand = vi.fn();
		const contents = {
			isDestroyed: () => false,
			once: vi.fn(),
			on: vi.fn(),
			debugger: { isAttached: () => false, attach, sendCommand, on: vi.fn() },
		} as unknown as Parameters<typeof ensureEmbeddedChromeIdentity>[0];

		await ensureEmbeddedChromeIdentity(contents);

		// No debugger attach either — an attached debugger is a signal of its own.
		expect(attach).not.toHaveBeenCalled();
		expect(sendCommand).not.toHaveBeenCalled();
	});
});
