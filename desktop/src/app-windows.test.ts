// The preload bridge (window.desktop) reaches the terminal PTY, open-file and
// settings IPC: host-level access. So a window that can show agent-written HTML
// must not carry it, and must not be a Chromium popup either, whose
// window.opener would be the bridged, same-origin main window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type Handler = (...args: unknown[]) => unknown;
	class FakeWindow {
		static created: FakeWindow[] = [];
		readonly handlers = new Map<string, Handler>();
		openHandler: Handler | null = null;
		readonly loadURL = vi.fn(async (_url: string) => undefined);
		readonly setParentWindow = vi.fn();
		readonly webContents = {
			on: (event: string, handler: Handler) => { this.handlers.set(event, handler); },
			setWindowOpenHandler: (handler: Handler) => { this.openHandler = handler; },
			getURL: () => "",
			executeJavaScript: vi.fn(async () => undefined),
		};
		constructor(readonly options: Record<string, unknown>) { FakeWindow.created.push(this); }
	}
	return {
		FakeWindow,
		token: "operator-secret-token",
		openExternal: vi.fn(async (_url: string) => undefined),
		openProjectFile: vi.fn(async (_path: string) => ""),
	};
});

vi.mock("electron", () => ({
	BrowserWindow: mocks.FakeWindow,
	shell: { openExternal: mocks.openExternal },
}));
vi.mock("./config", () => ({
	ICON_PATH: "",
	getLAXConfig: () => ({ port: 4321, authToken: mocks.token }),
}));
vi.mock("./open-project-file", () => ({ openProjectFile: mocks.openProjectFile }));
vi.mock("./theme", () => ({
	bgForTheme: () => "#ffffff",
	overlayForTheme: () => ({ color: "#ffffff", symbolColor: "#000000" }),
}));
vi.mock("./settings", () => ({ getSetting: () => "light" }));
vi.mock("./window-injections", () => ({ buildAppDragStripJs: () => "" }));
vi.mock("./window", () => ({ getMainWindow: () => null }));

import { handleWindowOpen, isAppShellUrl, openAccountWindow } from "./app-windows";

const ORIGIN = "http://127.0.0.1:4321";
const BRIDGELESS = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const created = mocks.FakeWindow.created;

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	log = vi.spyOn(console, "log").mockImplementation(() => {});
	created.length = 0;
	mocks.openExternal.mockClear();
	mocks.openProjectFile.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("an agent-written /files/ page", () => {
	const page = `${ORIGIN}/files/report.html?token=${mocks.token}`;

	it("opens in a window main creates, with no preload, not as a popup of the main window", () => {
		expect(handleWindowOpen(page)).toEqual({ action: "deny" });
		expect(created).toHaveLength(1);
		expect(created[0].options.webPreferences).toEqual(BRIDGELESS);
		expect(created[0].loadURL).toHaveBeenCalledWith(page);
	});

	it("routes the window's own popups and navigations back through the same handler", () => {
		handleWindowOpen(page);
		const [filesWindow] = created;

		expect(filesWindow.openHandler?.({ url: `${ORIGIN}/files/next.html` })).toEqual({ action: "deny" });
		expect(created).toHaveLength(2);
		expect(created[1].options.webPreferences).toEqual(BRIDGELESS);

		const navigate = (url: string) => {
			const preventDefault = vi.fn();
			filesWindow.handlers.get("will-navigate")?.({ preventDefault }, url);
			return preventDefault;
		};
		expect(navigate(`${ORIGIN}/files/next.html`)).not.toHaveBeenCalled();
		// The window has no address bar, so a remote page here passes for ours.
		// In the second URL everything before the @ is a username and password:
		// the host is evil.example.
		for (const foreign of ["https://evil.example/", `${ORIGIN}@evil.example/`]) {
			expect(navigate(foreign), foreign).toHaveBeenCalled();
			expect(mocks.openExternal).toHaveBeenCalledWith(foreign);
		}
	});
});

describe("window-open routing", () => {
	// The server redirects /apps to the agent origin, which needs no token, so
	// the operator token never reaches the browser's history or the app.
	it("sends /apps/ links to the system browser as they are, never an in-app window", () => {
		expect(handleWindowOpen(`${ORIGIN}/apps/game/`)).toEqual({ action: "deny" });
		expect(mocks.openExternal).toHaveBeenCalledWith(`${ORIGIN}/apps/game/`);
		expect(mocks.openExternal.mock.calls.flat().join(" ")).not.toContain(mocks.token);
		expect(created).toHaveLength(0);
	});

	// `http://127.0.0.1:4321` is a string prefix of port 43210, where any local
	// service would be opened or shown in an in-app window.
	it.each(["http://127.0.0.1:43210/files/x.html", "http://127.0.0.1:43210/tasks.html", "http://localhost:43210/apps/x/"])(
		"treats %s, another loopback port, as foreign",
		(url) => {
			expect(handleWindowOpen(url)).toEqual({ action: "deny" });
			expect(mocks.openExternal).not.toHaveBeenCalled();
			expect(created).toHaveLength(0);
		},
	);

	// Apps are served from the server's agent origin, a loopback port this
	// process is not told: an app opening one of its own pages goes where an
	// /apps link from the shell goes, never into an in-app window.
	it.each(["http://127.0.0.1:43210/apps/x/", "http://127.0.0.1:43210/dashboards/board"])(
		"sends %s, an app page on another loopback port, to the system browser",
		(url) => {
			expect(handleWindowOpen(url)).toEqual({ action: "deny" });
			expect(mocks.openExternal).toHaveBeenCalledWith(url);
			expect(created).toHaveLength(0);
		},
	);

	// window.open() with no URL asks for about:blank. An allowed popup inherits
	// the opener's webPreferences, preload included, and keeps the main window
	// as window.opener, so no URL may come back as "allow".
	it.each(["about:blank", "data:text/html,<p>x</p>", "javascript:void 0", "file:///C:/Users/me/page.html", "not a url"])(
		"never allows %s as a popup",
		(url) => {
			expect(handleWindowOpen(url)).toEqual({ action: "deny" });
			expect(created).toHaveLength(0);
		},
	);

	it("logs no query, fragment or credentials, so no token, OAuth code or password reaches the log", () => {
		handleWindowOpen(`${ORIGIN}/files/report.html?token=${mocks.token}`);
		handleWindowOpen("https://accounts.example.com/callback?code=oauth-secret-code#access_token=frag-secret");
		handleWindowOpen("https://basic-auth-user:basic-auth-secret@host.example/");
		const logged = log.mock.calls.flat().join("\n");
		expect(logged).toContain(`${ORIGIN}/files/report.html`);
		expect(logged).toContain("https://host.example/");
		for (const secret of [mocks.token, "oauth-secret-code", "frag-secret", "basic-auth-user", "basic-auth-secret"]) {
			expect(logged, secret).not.toContain(secret);
		}
	});
});

describe("the account window", () => {
	it("shows our own page without the preload", () => {
		openAccountWindow();
		expect(created).toHaveLength(1);
		expect(created[0].options.webPreferences).toEqual(BRIDGELESS);
		expect(created[0].loadURL).toHaveBeenCalledWith(`${ORIGIN}/account.html?token=${mocks.token}`);
	});
});

describe("isAppShellUrl", () => {
	it("accepts the app shell on the live origin", () => {
		expect(isAppShellUrl(`${ORIGIN}/?token=${mocks.token}`)).toBe(true);
	});

	it.each([
		`${ORIGIN}/files/report.html`,
		`${ORIGIN}/apps/game/`,
		`${ORIGIN}/account.html`,
		"http://127.0.0.1:43210/",
		`${ORIGIN}@evil.example/`,
		"https://evil.example/",
		"file:///C:/Users/me/page.html",
		"not a url",
	])("rejects %s", (url) => {
		expect(isAppShellUrl(url)).toBe(false);
	});
});
