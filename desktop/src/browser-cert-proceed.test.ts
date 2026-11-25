// "Proceed anyway" past an untrusted certificate: only for a host the user
// typed, only from the app's own window, only for that exact certificate.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	certListener: null as null | ((...args: unknown[]) => void),
	viewIdByWc: new Map<number, string>(),
	views: new Map<string, unknown>(),
}));

vi.mock("electron", () => ({
	app: { on: (name: string, fn: (...args: unknown[]) => void) => { if (name === "certificate-error") h.certListener = fn; } },
	ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); } },
}));
vi.mock("./browser-page-controls", () => ({
	isTrustedBrowserSender: (sender: { trusted?: boolean }) => sender.trusted === true,
}));
vi.mock("./browser-views", () => ({
	viewIdForWebContents: (id: number) => h.viewIdByWc.get(id) ?? null,
	getBrowserView: (viewId: string) => h.views.get(viewId),
}));

import {
	_resetCertTrustForTests,
	canProceedPastCertificate,
	noteTypedNavigation,
	setupBrowserCertProceed,
} from "./browser-cert-proceed";

const ROUTER = "https://192.168.1.254/";
const CERT = { fingerprint: "sha256/ROUTER" };

function tab(id: number, viewId: string) {
	const loads: string[] = [];
	const wc = { id, isDestroyed: () => false, loadURL: (u: string) => { loads.push(u); return Promise.resolve(); } };
	h.viewIdByWc.set(id, viewId);
	h.views.set(viewId, { webContents: wc });
	return { wc, loads };
}

/** Fire Chromium's certificate-error for this tab; true when it was accepted. */
function certError(wc: unknown, url: string, cert = CERT): boolean {
	let prevented = false;
	let accepted: boolean | null = null;
	h.certListener!({ preventDefault: () => { prevented = true; } }, wc, url, "net::ERR_CERT_AUTHORITY_INVALID", cert, (ok: boolean) => { accepted = ok; });
	return prevented && accepted === true;
}

const proceed = (viewId: string, trusted = true) => h.handlers.get("browser-cert-proceed")!({ sender: { trusted } }, viewId);

beforeEach(() => {
	h.handlers.clear();
	h.viewIdByWc.clear();
	h.views.clear();
	_resetCertTrustForTests();
	setupBrowserCertProceed();
});

describe("Proceed anyway past an untrusted certificate", () => {
	it("a host the user typed gets the button; proceeding trusts it and loads it again", () => {
		const { wc, loads } = tab(1, "user-1");
		noteTypedNavigation(wc as never, "https://192.168.1.254");
		expect(certError(wc, ROUTER)).toBe(false);
		expect(canProceedPastCertificate(wc as never, ROUTER)).toBe(true);
		expect(proceed("user-1")).toBe(true);
		expect(loads).toEqual([ROUTER]);
		// The reload, and the agent's later visits to the same site, are accepted.
		expect(certError(wc, ROUTER)).toBe(true);
		const agent = tab(2, "agent-view");
		expect(certError(agent.wc, "https://192.168.1.254/admin")).toBe(true);
	});

	it("a page the agent navigated to gets no button and cannot be proceeded past", () => {
		const { wc, loads } = tab(1, "agent-view");
		noteTypedNavigation(wc as never, "https://example.com/");
		expect(certError(wc, "https://bank-login.example.net/")).toBe(false);
		expect(canProceedPastCertificate(wc as never, "https://bank-login.example.net/")).toBe(false);
		expect(proceed("agent-view")).toBe(false);
		expect(loads).toEqual([]);
	});

	it("only the app's own window can proceed", () => {
		const { wc } = tab(1, "user-1");
		noteTypedNavigation(wc as never, ROUTER);
		certError(wc, ROUTER);
		expect(proceed("user-1", false)).toBe(false);
		expect(certError(wc, ROUTER)).toBe(false);
	});

	it("a different certificate for a trusted host is refused and asks again", () => {
		const { wc } = tab(1, "user-1");
		noteTypedNavigation(wc as never, ROUTER);
		certError(wc, ROUTER);
		proceed("user-1");
		expect(certError(wc, ROUTER, { fingerprint: "sha256/INTERCEPTOR" })).toBe(false);
		expect(canProceedPastCertificate(wc as never, ROUTER)).toBe(true);
	});

	it("the app's own window never accepts a bad certificate", () => {
		const appWindow = { id: 99, isDestroyed: () => false, loadURL: () => Promise.resolve() };
		noteTypedNavigation(appWindow as never, ROUTER);
		expect(certError(appWindow, ROUTER)).toBe(false);
		expect(canProceedPastCertificate(appWindow as never, ROUTER)).toBe(false);
	});
});
