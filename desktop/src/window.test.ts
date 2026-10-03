// The main window is the one window that carries the preload bridge
// (window.desktop: terminal PTY, open-file, settings IPC). It therefore may
// only ever show the app shell; a navigation that would put an agent page, a
// local file or an external site under that bridge is cancelled and routed the
// way window.open routes it.
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	type Handler = (...args: unknown[]) => unknown;
	class FakeWindow {
		static created: FakeWindow[] = [];
		readonly handlers = new Map<string, Handler>();
		readonly loadURL = vi.fn(async (_url: string) => undefined);
		readonly maximize = vi.fn();
		readonly isDestroyed = () => false;
		readonly on = vi.fn();
		readonly once = vi.fn();
		readonly webContents = {
			on: (event: string, handler: Handler) => { this.handlers.set(event, handler); },
			setWindowOpenHandler: vi.fn(),
			getURL: () => "",
		};
		constructor(readonly options: Record<string, unknown>) { FakeWindow.created.push(this); }
	}
	return {
		FakeWindow,
		openExternal: vi.fn(async (_url: string) => undefined),
		openProjectFile: vi.fn(async (_path: string) => ""),
	};
});

vi.mock("electron", () => ({
	BrowserWindow: mocks.FakeWindow,
	Menu: class {},
	MenuItem: class {},
	shell: { openExternal: mocks.openExternal },
}));
vi.mock("./config", () => ({
	ICON_PATH: "",
	getLAXConfig: () => ({ port: 4321, authToken: "tok" }),
	reloadLAXConfig: () => ({ port: 4321, authToken: "tok" }),
}));
vi.mock("./settings", () => ({
	getSetting: (key: string) => (key === "windowBounds" ? { width: 1200, height: 800 } : key === "theme" ? "light" : false),
	setSetting: () => undefined,
}));
vi.mock("./theme", () => ({
	bgForTheme: () => "#ffffff",
	overlayForTheme: () => ({ color: "#ffffff", symbolColor: "#000000" }),
}));
vi.mock("./splash", () => ({ buildSplashDataUrl: () => "data:text/html,splash" }));
vi.mock("./server-process", () => ({
	isServerRunning: () => new Promise<boolean>(() => {}),
	isQuittingFlag: () => false,
}));
vi.mock("./open-project-file", () => ({ openProjectFile: mocks.openProjectFile }));
vi.mock("./window-injections", () => ({ buildAppDragStripJs: () => "" }));

import { createWindow } from "./window";

const ORIGIN = "http://127.0.0.1:4321";
const BRIDGELESS = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const created = mocks.FakeWindow.created;

function navigateMainWindow(url: string): ReturnType<typeof vi.fn> {
	const preventDefault = vi.fn();
	created[0].handlers.get("will-navigate")?.({ preventDefault }, url);
	return preventDefault;
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	created.length = 0;
	mocks.openExternal.mockClear();
	mocks.openProjectFile.mockClear();
	createWindow();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the main window", () => {
	it("is the window that carries the preload, sandboxed and isolated", () => {
		expect(created).toHaveLength(1);
		expect(created[0].options.webPreferences).toMatchObject({
			preload: expect.stringMatching(/preload\.js$/),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		});
	});

	it("navigates to the app shell", () => {
		expect(navigateMainWindow(`${ORIGIN}/?token=tok`)).not.toHaveBeenCalled();
	});

	it.each([
		`${ORIGIN}/files/report.html?token=tok`,
		`${ORIGIN}/apps/game/`,
		`${ORIGIN}/account.html`,
		"http://127.0.0.1:43210/",
		`${ORIGIN}@evil.example/`,
		"https://evil.example/",
		"file:///C:/Users/me/dropped.html",
	])("never shows %s under the bridge", (url) => {
		expect(navigateMainWindow(url)).toHaveBeenCalled();
		for (const w of created.slice(1)) expect(w.options.webPreferences).toEqual(BRIDGELESS);
	});

	it("opens a /files/ page it was sent to in a window without the bridge", () => {
		const page = `${ORIGIN}/files/report.html?token=tok`;
		navigateMainWindow(page);
		expect(created).toHaveLength(2);
		expect(created[1].options.webPreferences).toEqual(BRIDGELESS);
		expect(created[1].loadURL).toHaveBeenCalledWith(page);
	});

	it("hands an external site to the system browser", () => {
		navigateMainWindow("https://evil.example/");
		expect(mocks.openExternal).toHaveBeenCalledWith("https://evil.example/");
	});

	it("hands a linked document to its native app", async () => {
		expect(navigateMainWindow(`${ORIGIN}/files/report.pdf`)).toHaveBeenCalled();
		await vi.waitFor(() => expect(mocks.openProjectFile).toHaveBeenCalledWith(join("workspace", "report.pdf")));
	});
});
