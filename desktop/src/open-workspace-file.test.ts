// Opening a workspace file hands it to the OS default handler, which runs a
// program as readily as it shows a document. Programs open with no prompt, so
// what keeps a link honest is that the handler opens exactly the file it names:
// inside the workspace, existing as written, with no component Win32 renames.
// Pinned at both doors that reach shell.openPath with an agent-influenced path:
// the "open-file" IPC and the window-open / will-navigate document route.
//
// The workspace is where the server says it is, which need not be under the
// project root: on the owner's machine it is Documents\Local Agent X\workspace
// while the project root's own workspace folder is another directory, and every
// click on a deck there did nothing (2026-11-23).
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
vi.mock("./approval-presence-ipc", () => ({ setupApprovalPresenceIPC: () => undefined }));
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
import { setWorkspaceRoot } from "./open-workspace-file";

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
let workspace: string;
const inWorkspace = (name: string) => join(workspace, name);

let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "lax-open-file-"));
	mocks.root = join(base, "project");
	// The real workspace lives elsewhere; the project root has a stale folder of
	// the same name, holding a file the real workspace does not.
	workspace = join(base, "Documents", "Local Agent X", "workspace");
	mkdirSync(join(mocks.root, "workspace"), { recursive: true });
	writeFileSync(join(mocks.root, "workspace", "stale.pdf"), "x");
	mkdirSync(inWorkspace("docs."), { recursive: true });
	for (const name of [...FILES, "docs./notes.pdf", "LAX-Pitch-Deck.pptx"]) writeFileSync(inWorkspace(name), "x");
	writeFileSync(join(base, "outside.pdf"), "x");
	writeFileSync(join(mocks.root, "README.md"), "x");
	setWorkspaceRoot(workspace);
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

	it("opens the file in the workspace the server named, not the project root's folder of that name", async () => {
		expect(await openFile("workspace/LAX-Pitch-Deck.pptx")).toBe("");
		expect(mocks.openPath).toHaveBeenCalledWith(inWorkspace("LAX-Pitch-Deck.pptx"));
		expect(await openFile("workspace/stale.pdf")).toBe("rejected: no such file");
		expect(mocks.openPath).toHaveBeenCalledTimes(1);
	});

	it("refuses an existing file outside the workspace, by relative or absolute path", async () => {
		expect(await openFile("workspace/../../../outside.pdf")).toBe("rejected: path outside the workspace");
		expect(await openFile(`workspace/${join(base, "outside.pdf")}`)).toBe("rejected: path outside the workspace");
		expect(await openFile("workspace/..")).toBe("rejected: path outside the workspace");
		expect(mocks.openPath).not.toHaveBeenCalled();
	});

	it("refuses a path not written as a workspace file, so nothing else in the project opens", async () => {
		expect(await openFile("README.md")).toBe("rejected: not a workspace file");
		expect(await openFile(join(base, "outside.pdf"))).toBe("rejected: not a workspace file");
		expect(await openFile(42 as unknown as string)).toBe("rejected: not a workspace file");
		expect(mocks.openPath).not.toHaveBeenCalled();
	});
});

describe("the workspace root", () => {
	it("is taken only as an absolute path; a relative one leaves the announced root in place", async () => {
		setWorkspaceRoot("relative/workspace");
		setWorkspaceRoot(undefined);
		expect(await openFile("workspace/report.pdf")).toBe("");
		expect(mocks.openPath).toHaveBeenCalledWith(inWorkspace("report.pdf"));
	});

	it("before the server has said where it is, nothing opens and the click is told why", async () => {
		vi.resetModules();
		const fresh = await import("./open-workspace-file");
		expect(await fresh.openWorkspaceFile("workspace/report.pdf")).toBe("the workspace location is not known yet");
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
