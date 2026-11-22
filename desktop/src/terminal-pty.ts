// The TERMINAL tab's shells. Each chat has its own, opened in that chat's
// project folder: one shell per window used to serve every chat, started in
// LAX's own folder, so a command typed for one chat's project ran wherever the
// last chat had left the shell (2026-11-22). A shell is keyed by the window
// that owns it and the chat it belongs to ("" with no chat on screen); output
// and exit are sent tagged with that chat so the panel routes them to the
// right pane (public/js/terminal-panel.js).
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "os";
import { chmodSync, statSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import * as pty from "node-pty";
import { getProjectRoot } from "./config";

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;
const MAX_WRITE_LENGTH = 1024 * 1024;
const MAX_CHAT_ID_LENGTH = 200;
/** Shells one window keeps. Past it, the one quiet the longest is closed:
 *  a shell with a job still printing counts as in use. */
export const MAX_SHELLS_PER_WINDOW = 8;

type TerminalSize = { cols: number; rows: number };

interface TerminalSession {
	process: pty.IPty;
	owner: WebContents;
	chat: string;
	disposed: boolean;
	/** Last input or output, for choosing which shell to close at the cap. */
	lastActiveAt: number;
}

const sessions = new Map<string, TerminalSession>();
/** Windows whose close already disposes their shells. */
const watchedOwners = new Set<number>();

// A webContents id is a number, so the first ":" always ends it.
const keyOf = (ownerId: number, chat: string): string => `${ownerId}:${chat}`;

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

/** The chat a terminal call is for: "" when none is on screen. */
export function validateTerminalChat(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new TypeError("Terminal chat must be a string");
	if (value.length > MAX_CHAT_ID_LENGTH) throw new RangeError("Terminal chat id is too long");
	return value;
}

/** Where a chat's shell starts: the folder asked for when it is a real
 *  directory, else `fallback`. The shell can go anywhere once open; this only
 *  keeps a stale or mistyped folder from failing the spawn. */
export function terminalStartFolder(requested: unknown, fallback: string): string {
	if (typeof requested !== "string" || !requested || !isAbsolute(requested)) return fallback;
	try {
		return statSync(requested).isDirectory() ? requested : fallback;
	} catch {
		return fallback; // gone or unreadable
	}
}

// npm does not reliably preserve the execute bit on files extracted from
// package tarballs. node-pty's darwin/linux prebuilds ship a `spawn-helper`
// binary that pty.spawn() execs via posix_spawnp; when an install strips its
// exec bit (observed 2026-07-18), every terminal create dies with
// "Error: posix_spawnp failed." Restore the bit before spawning.
export function ensureSpawnHelperExecutable(resolvePtyDir?: () => string): void {
	if (process.platform === "win32") return;
	try {
		const ptyDir = resolvePtyDir
			? resolvePtyDir()
			: dirname(require.resolve("node-pty/package.json"));
		const helper = join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
		const mode = statSync(helper).mode;
		if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
	} catch {
		// Helper missing (e.g. source build) — node-pty will surface its own error.
	}
}

function shellForPlatform(): string {
	if (process.platform === "win32") return "powershell.exe";
	if (process.platform === "darwin") return process.env.SHELL || "/bin/zsh";
	return process.env.SHELL || "/bin/bash";
}

function disposeSession(key: string, kill = true): void {
	const session = sessions.get(key);
	if (!session || session.disposed) return;
	session.disposed = true;
	sessions.delete(key);
	if (kill) session.process.kill();
}

function disposeOwner(ownerId: number): void {
	watchedOwners.delete(ownerId);
	for (const [key, session] of [...sessions]) if (session.owner.id === ownerId) disposeSession(key);
}

function sessionFor(event: IpcMainInvokeEvent, chat: string): TerminalSession | undefined {
	return sessions.get(keyOf(event.sender.id, chat));
}

/** Make room for one more shell in this window: close the quietest ones, and
 *  tell the panel so that chat's pane starts a fresh shell when next shown. */
function closeQuietestOver(owner: WebContents): void {
	const mine = [...sessions.entries()].filter(([, s]) => s.owner.id === owner.id).sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
	for (const [key, session] of mine.slice(0, Math.max(0, mine.length - MAX_SHELLS_PER_WINDOW + 1))) {
		if (!owner.isDestroyed()) owner.send("terminal-exit", { exitCode: 0, chat: session.chat, closed: true });
		disposeSession(key);
	}
}

function createSession(event: IpcMainInvokeEvent, size: TerminalSize, chat: string, folder: unknown): void {
	if (sessionFor(event, chat)) return;
	ensureSpawnHelperExecutable();
	const owner = event.sender;
	closeQuietestOver(owner);
	const terminalProcess = pty.spawn(shellForPlatform(), [], {
		name: "xterm-256color",
		cols: size.cols,
		rows: size.rows,
		cwd: terminalStartFolder(folder, getProjectRoot() || homedir()),
		env: process.env as Record<string, string>,
	});
	const key = keyOf(owner.id, chat);
	const session: TerminalSession = { process: terminalProcess, owner, chat, disposed: false, lastActiveAt: Date.now() };
	sessions.set(key, session);

	terminalProcess.onData((data) => {
		session.lastActiveAt = Date.now();
		if (!session.disposed && !owner.isDestroyed()) owner.send("terminal-data", data, chat);
	});
	terminalProcess.onExit(({ exitCode, signal }) => {
		if (!session.disposed && !owner.isDestroyed()) owner.send("terminal-exit", { exitCode, signal, chat });
		disposeSession(key, false);
	});
	if (watchedOwners.has(owner.id)) return;
	watchedOwners.add(owner.id);
	owner.once("destroyed", () => disposeOwner(owner.id));
	BrowserWindow.fromWebContents(owner)?.once("closed", () => disposeOwner(owner.id));
}

export function setupTerminalIPC(): void {
	ipcMain.handle("terminal-create", (event, cols: unknown, rows: unknown, chat: unknown, folder: unknown) => {
		createSession(event, validateTerminalSize(cols, rows), validateTerminalChat(chat), folder);
	});
	ipcMain.handle("terminal-write", (event, value: unknown, chat: unknown) => {
		const data = validateTerminalWrite(value);
		const session = sessionFor(event, validateTerminalChat(chat));
		if (!session) return;
		session.lastActiveAt = Date.now();
		session.process.write(data);
	});
	ipcMain.handle("terminal-resize", (event, cols: unknown, rows: unknown, chat: unknown) => {
		const size = validateTerminalSize(cols, rows);
		sessionFor(event, validateTerminalChat(chat))?.process.resize(size.cols, size.rows);
	});
	ipcMain.handle("terminal-dispose", (event, chat: unknown) => disposeSession(keyOf(event.sender.id, validateTerminalChat(chat))));
}

export function disposeAllTerminals(): void {
	watchedOwners.clear();
	for (const key of [...sessions.keys()]) disposeSession(key);
}
