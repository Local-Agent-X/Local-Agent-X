// Opening a project file hands it to the OS default handler, which runs a
// program as readily as it shows a document. Programs open with no prompt, so
// what keeps a link honest is that the handler opens exactly the file it names:
// inside PROJECT_ROOT, existing as written, with no component Win32 renames.
// Pinned at both doors that reach shell.openPath with an agent-influenced path:
// the "open-file" IPC and the window-open / will-navigate document route.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	root: "",
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	showMessageBox: vi.fn(),
	openPath: vi.fn(async (_path: string) => ""),
}));

vi.mock("electron", () => ({
	dialog: { showMessageBox: mocks.showMessageBox },
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			mocks.handlers.set(channel, handler);
		},
	},
	shell: { openPath: mocks.openPath, openExternal: vi.fn() },
}));
vi.mock("./config", () => ({
	getProjectRoot: () => mocks.root,
	getLAXConfig: () => ({ port: 4321, authToken: "tok" }),
	reloadLAXConfig: () => undefined,
	LAX_DIR: "",
	ICON_PATH: "",
}));
vi.mock("./window", () => ({}));
vi.mock("./browser-ipc", () => ({ setupBrowserIPC: () => undefined }));
vi.mock("./terminal-pty", () => ({ setupTerminalIPC: () => undefined }));
vi.mock("./native-updater", () => ({ setupNativeUpdaterIPC: () => undefined }));
vi.mock("./settings", () => ({}));
vi.mock("./theme", () => ({}));
vi.mock("./server-process", () => ({}));
vi.mock("./hotkey-notifications", () => ({}));
vi.mock("./autostart", () => ({}));
vi.mock("./native-speech", () => ({}));
vi.mock("./window-injections", () => ({}));
vi.mock("./app-window-guards", () => ({}));

import { setupIPC } from "./ipc";
import { handleWindowOpen } from "./app-windows";

const FILES = [
	"run.exe", "setup.bat", "report.pdf", "notes.docx", "run.cmd",
	// Literal names Node's fs can create beside run.cmd; Win32 opens run.cmd for both.
	"run.cmd.", "run.cmd ",
];

function openFile(relativePath: string): Promise<string> {
	const handler = mocks.handlers.get("open-file");
	if (!handler) throw new Error("open-file is not registered");
	return handler({ sender: {} }, relativePath) as Promise<string>;
}

let base: string;
const inWorkspace = (name: string) => join(mocks.root, "workspace", name);

let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "lax-open-file-"));
	mocks.root = join(base, "project");
	mkdirSync(join(mocks.root, "workspace"), { recursive: true });
	mkdirSync(inWorkspace("docs."));
	for (const name of [...FILES, "docs./notes.pdf"]) writeFileSync(inWorkspace(name), "x");
	writeFileSync(join(base, "outside.pdf"), "x");
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.handlers.clear();
	mocks.showMessageBox.mockClear();
	mocks.openPath.mockClear();
	setupIPC();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("open-file IPC", () => {
	it.each(["run.exe", "setup.bat", "report.pdf", "notes.docx"])("opens the existing %s with no prompt", async (name) => {
		expect(await openFile(`workspace/${name}`)).toBe("");
		expect(mocks.openPath).toHaveBeenCalledWith(inWorkspace(name));
		expect(mocks.showMessageBox).not.toHaveBeenCalled();
	});

	// ShellExecute runs a sibling run.cmd for a missing `run` and truncates at a
	// NUL to run.exe, so neither may reach it.
	it.each(["run", "run.exe\u0000.pdf"])("refuses %j, a path the OS would rewrite into a program", async (name) => {
		expect(await openFile(`workspace/${name}`)).toBe("rejected: no such file");
		expect(mocks.openPath).not.toHaveBeenCalled();
	});

	// These exist exactly as written, yet ShellExecute strips the trailing dot or
	// space from each component and opens run.cmd or docs\notes.pdf instead.
	it.each(["run.cmd.", "run.cmd ", "docs./notes.pdf"])("refuses the existing %j, whose name Win32 rewrites", async (name) => {
		expect(existsSync(inWorkspace(name))).toBe(true);
		expect(await openFile(`workspace/${name}`)).toBe("rejected: a name ends in a dot or space");
		expect(mocks.openPath).not.toHaveBeenCalled();
	});

	it("refuses an existing file outside the project root, by relative or absolute path", async () => {
		expect(await openFile("../outside.pdf")).toBe("rejected: path outside project root");
		expect(await openFile(join(base, "outside.pdf"))).toBe("rejected: path outside project root");
		expect(mocks.openPath).not.toHaveBeenCalled();
	});
});

describe("window-open never opens a document in its program", () => {
	// An agent frame can call window.open with no click (GHSA-9mv6). The shell
	// opens documents through desktop.openFile (the open-file IPC above, which
	// opens with no prompt); a page asking through window.open gets nothing
	// launched, whatever the path, encoded NUL included.
	it.each(["report.pdf", "notes.docx", "run.exe%00.pdf"])("refuses to launch %s", async (name) => {
		expect(handleWindowOpen(`http://127.0.0.1:4321/${name}`)).toEqual({ action: "deny" });
		await new Promise((r) => setTimeout(r, 20));
		expect(mocks.openPath).not.toHaveBeenCalled();
		expect(mocks.showMessageBox).not.toHaveBeenCalled();
	});
});
