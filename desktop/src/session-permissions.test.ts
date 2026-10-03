// The account window shares the app shell's origin, so the microphone,
// clipboard reads and notifications are granted only to requests attributed to
// the main window's top frame. Agent-built pages are served from the server's
// agent origin, another loopback port, and framed sandboxed, so they get only
// the clipboard write any site gets in the in-app browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RequestHandler = (
	wc: unknown,
	permission: string,
	callback: (granted: boolean) => void,
	details: { isMainFrame: boolean; requestingUrl: string },
) => void;
type CheckHandler = (wc: unknown, permission: string, origin: string, details: { isMainFrame: boolean }) => boolean;

const mocks = vi.hoisted(() => ({
	request: null as RequestHandler | null,
	check: null as CheckHandler | null,
	mainWebContents: { id: "main" },
	mainWindow: null as { webContents: unknown; isDestroyed: () => boolean } | null,
}));

vi.mock("electron", () => ({
	session: {
		defaultSession: {
			on: () => {},
			setPermissionRequestHandler: (fn: RequestHandler) => { mocks.request = fn; },
			setPermissionCheckHandler: (fn: CheckHandler) => { mocks.check = fn; },
		},
	},
	shell: { openExternal: async () => undefined, openPath: async () => "" },
	dialog: {},
}));
vi.mock("./config", () => ({ getLAXConfig: () => ({ port: 4321, authToken: "operator-secret-token" }) }));
vi.mock("./window", () => ({ getMainWindow: () => mocks.mainWindow }));

import { setupSessionPermissions } from "./session-permissions";

const ORIGIN = "http://127.0.0.1:4321";
const SHELL = `${ORIGIN}/?token=operator-secret-token`;
const otherWindow = { id: "files-window" };

function request(wc: unknown, permission: string, isMainFrame: boolean, requestingUrl: string): boolean {
	let granted: boolean | undefined;
	mocks.request!(wc, permission, (g) => { granted = g; }, { isMainFrame, requestingUrl });
	return granted!;
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.mainWindow = { webContents: mocks.mainWebContents, isDestroyed: () => false };
	setupSessionPermissions();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the app shell", () => {
	it.each(["media", "mediaKeySystem", "notifications", "clipboard-read", "clipboard-sanitized-write"])(
		"is granted %s in the main window's top frame",
		(permission) => {
			expect(request(mocks.mainWebContents, permission, true, SHELL)).toBe(true);
			expect(mocks.check!(mocks.mainWebContents, permission, ORIGIN, { isMainFrame: true })).toBe(true);
		},
	);

	it("is never granted a permission outside the list", () => {
		expect(request(mocks.mainWebContents, "geolocation", true, SHELL)).toBe(false);
		expect(mocks.check!(mocks.mainWebContents, "geolocation", ORIGIN, { isMainFrame: true })).toBe(false);
	});
});

describe("other documents on the app origin", () => {
	it.each(["media", "notifications", "clipboard-read"])("an /apps/ iframe in the shell asking for itself is denied %s", (permission) => {
		expect(request(mocks.mainWebContents, permission, false, `${ORIGIN}/apps/game/`)).toBe(false);
		expect(mocks.check!(mocks.mainWebContents, permission, ORIGIN, { isMainFrame: false })).toBe(false);
	});

	it.each(["media", "notifications", "clipboard-read"])("a /files/ window is denied %s", (permission) => {
		expect(request(otherWindow, permission, true, `${ORIGIN}/files/report.html`)).toBe(false);
		expect(mocks.check!(otherWindow, permission, ORIGIN, { isMainFrame: true })).toBe(false);
	});

	it("may still write the clipboard, as any site in the in-app browser may", () => {
		expect(request(otherWindow, "clipboard-sanitized-write", true, `${ORIGIN}/files/report.html`)).toBe(true);
		expect(request(mocks.mainWebContents, "clipboard-sanitized-write", false, `${ORIGIN}/apps/game/`)).toBe(true);
	});

	it("nothing is granted before the main window exists or after it is destroyed", () => {
		mocks.mainWindow = null;
		expect(request(mocks.mainWebContents, "media", true, SHELL)).toBe(false);
		mocks.mainWindow = { webContents: mocks.mainWebContents, isDestroyed: () => true };
		expect(request(mocks.mainWebContents, "media", true, SHELL)).toBe(false);
	});
});

describe("an agent-built app framed in the shell from the agent origin", () => {
	const AGENT_APP = "http://127.0.0.1:51234/apps/game/";

	it("may write the clipboard for its copy button", () => {
		expect(request(mocks.mainWebContents, "clipboard-sanitized-write", false, AGENT_APP)).toBe(true);
		expect(mocks.check!(mocks.mainWebContents, "clipboard-sanitized-write", "http://127.0.0.1:51234", { isMainFrame: false })).toBe(true);
	});

	it.each(["media", "notifications", "clipboard-read"])("is denied %s", (permission) => {
		expect(request(mocks.mainWebContents, permission, false, AGENT_APP)).toBe(false);
	});

	it("gets nothing outside the main window, or from a non-loopback frame", () => {
		expect(request(otherWindow, "clipboard-sanitized-write", false, AGENT_APP)).toBe(false);
		expect(request(mocks.mainWebContents, "clipboard-sanitized-write", false, "https://evil.example/")).toBe(false);
	});
});

describe("other origins", () => {
	it.each([
		"http://127.0.0.1:43210/",
		`${ORIGIN}@evil.example/`,
		"https://evil.example/",
		"data:text/html,<p>splash</p>",
		"not a url",
	])("%s is granted nothing, even in the main window's top frame", (url) => {
		for (const permission of ["media", "clipboard-sanitized-write"]) {
			expect(request(mocks.mainWebContents, permission, true, url), permission).toBe(false);
			expect(mocks.check!(mocks.mainWebContents, permission, url, { isMainFrame: true }), permission).toBe(false);
		}
	});
});

it("logs a denial by origin, never the token in the shell's URL", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	request(mocks.mainWebContents, "geolocation", true, SHELL);
	const logged = warn.mock.calls.flat().join("\n");
	expect(logged).toContain(ORIGIN);
	expect(logged).not.toContain("operator-secret-token");
});
