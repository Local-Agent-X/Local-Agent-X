import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "os";
import * as pty from "node-pty";
import { getProjectRoot } from "./config";

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;
const MAX_WRITE_LENGTH = 1024 * 1024;

type TerminalSize = { cols: number; rows: number };

interface TerminalSession {
	process: pty.IPty;
	owner: WebContents;
	disposed: boolean;
}

const sessions = new Map<number, TerminalSession>();

export function validateTerminalWrite(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Terminal input must be a string");
	if (value.length > MAX_WRITE_LENGTH) throw new RangeError("Terminal input is too large");
	return value;
}

export function validateTerminalSize(cols: unknown, rows: unknown): TerminalSize {
	if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
		throw new TypeError("Terminal dimensions must be finite numbers");
	}
	return {
		cols: Math.min(MAX_COLS, Math.max(MIN_COLS, Math.trunc(cols as number))),
		rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.trunc(rows as number))),
	};
}

function shellForPlatform(): string {
	if (process.platform === "win32") return "powershell.exe";
	if (process.platform === "darwin") return process.env.SHELL || "/bin/zsh";
	return process.env.SHELL || "/bin/bash";
}

function disposeSession(webContentsId: number, kill = true): void {
	const session = sessions.get(webContentsId);
	if (!session || session.disposed) return;
	session.disposed = true;
	sessions.delete(webContentsId);
	if (kill) session.process.kill();
}

function sessionFor(event: IpcMainInvokeEvent): TerminalSession | undefined {
	return sessions.get(event.sender.id);
}

function createSession(event: IpcMainInvokeEvent, size: TerminalSize): void {
	if (sessionFor(event)) return;
	const owner = event.sender;
	const terminalProcess = pty.spawn(shellForPlatform(), [], {
		name: "xterm-256color",
		cols: size.cols,
		rows: size.rows,
		cwd: getProjectRoot() || homedir(),
		env: process.env as Record<string, string>,
	});
	const session: TerminalSession = { process: terminalProcess, owner, disposed: false };
	sessions.set(owner.id, session);

	terminalProcess.onData((data) => {
		if (!session.disposed && !owner.isDestroyed()) owner.send("terminal-data", data);
	});
	terminalProcess.onExit(({ exitCode, signal }) => {
		if (!session.disposed && !owner.isDestroyed()) owner.send("terminal-exit", { exitCode, signal });
		disposeSession(owner.id, false);
	});
	owner.once("destroyed", () => disposeSession(owner.id));
	BrowserWindow.fromWebContents(owner)?.once("closed", () => disposeSession(owner.id));
}

export function setupTerminalIPC(): void {
	ipcMain.handle("terminal-create", (event, cols: unknown, rows: unknown) => {
		createSession(event, validateTerminalSize(cols, rows));
	});
	ipcMain.handle("terminal-write", (event, value: unknown) => {
		const data = validateTerminalWrite(value);
		sessionFor(event)?.process.write(data);
	});
	ipcMain.handle("terminal-resize", (event, cols: unknown, rows: unknown) => {
		const size = validateTerminalSize(cols, rows);
		sessionFor(event)?.process.resize(size.cols, size.rows);
	});
	ipcMain.handle("terminal-dispose", (event) => disposeSession(event.sender.id));
}

export function disposeAllTerminals(): void {
	for (const webContentsId of [...sessions.keys()]) disposeSession(webContentsId);
}
