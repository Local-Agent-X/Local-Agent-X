import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	buildEmbeddedChromeIdentity,
	ensureEmbeddedChromeIdentity,
	prepareEmbeddedChromeIdentityForNavigation,
	registerEmbeddedChromeIdentitySession,
} from "./embedded-chrome-identity";

describe("embedded Chrome identity", () => {
	const originalChrome = Object.getOwnPropertyDescriptor(process.versions, "chrome");
	beforeAll(() => {
		Object.defineProperty(process.versions, "chrome", {
			value: "150.0.7339.2",
			configurable: true,
		});
	});
	afterAll(() => {
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
		const browserSession = {};
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
		expect(app.on).toHaveBeenCalledWith("web-contents-created", expect.any(Function));
	});
});
