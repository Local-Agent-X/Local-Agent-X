import { EventEmitter } from "events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	spawn: vi.fn(),
}));

vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: () => null },
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
			mocks.handlers.set(channel, handler);
		},
	},
}));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));
vi.mock("./config", () => ({ getProjectRoot: () => "C:\\project" }));

import { disposeAllTerminals, ensureSpawnHelperExecutable, MAX_SHELLS_PER_WINDOW, setupTerminalIPC, terminalStartFolder, validateTerminalChat, validateTerminalSize, validateTerminalWrite } from "./terminal-pty";

class FakeOwner extends EventEmitter {
	readonly send = vi.fn();
	destroyed = false;
	constructor(readonly id: number) { super(); }
	isDestroyed(): boolean { return this.destroyed; }
}

function fakePty() {
	let onData: (data: string) => void = () => undefined;
	let onExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
	return {
		write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
		onData: vi.fn((cb: typeof onData) => { onData = cb; return { dispose: vi.fn() }; }),
		onExit: vi.fn((cb: typeof onExit) => { onExit = cb; return { dispose: vi.fn() }; }),
		emitData: (data: string) => onData(data),
		emitExit: (event: { exitCode: number; signal?: number }) => onExit(event),
	};
}

function invoke(channel: string, owner: FakeOwner, ...args: unknown[]) {
	const handler = mocks.handlers.get(channel);
	if (!handler) throw new Error(`Missing handler: ${channel}`);
	return handler({ sender: owner }, ...args);
}

describe("terminal PTY IPC", () => {
	beforeEach(() => {
		disposeAllTerminals();
		mocks.handlers.clear();
		mocks.spawn.mockReset();
		setupTerminalIPC();
	});

	it("creates one session per renderer and routes output only to its owner", () => {
		const first = fakePty();
		const second = fakePty();
		mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
		const ownerA = new FakeOwner(10);
		const ownerB = new FakeOwner(20);

		invoke("terminal-create", ownerA, 120, 40);
		invoke("terminal-create", ownerA, 80, 24);
		invoke("terminal-create", ownerB, 80, 24);
		first.emitData("A");
		second.emitData("B");

		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(ownerA.send).toHaveBeenCalledWith("terminal-data", "A", "");
		expect(ownerA.send).not.toHaveBeenCalledWith("terminal-data", "B", "");
		expect(ownerB.send).toHaveBeenCalledWith("terminal-data", "B", "");
	});

	// One shell per window served every chat, opened in LAX's own folder
	// (2026-11-22). Each chat now has its own, in its project folder.
	it("gives each chat its own shell, opened in that chat's folder, and routes I/O by chat", () => {
		const shellA = fakePty();
		const shellB = fakePty();
		mocks.spawn.mockReturnValueOnce(shellA).mockReturnValueOnce(shellB);
		const owner = new FakeOwner(50);
		const folder = mkdtempSync(join(tmpdir(), "pty-chat-"));
		try {
			invoke("terminal-create", owner, 80, 24, "chat-a", folder);
			invoke("terminal-create", owner, 80, 24, "chat-b", join(folder, "no-such-folder"));
			invoke("terminal-create", owner, 80, 24, "chat-a", folder); // already has one

			expect(mocks.spawn).toHaveBeenCalledTimes(2);
			expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: folder });
			// A folder that is not there falls back to the app's own.
			expect(mocks.spawn.mock.calls[1][2]).toMatchObject({ cwd: "C:\\project" });

			invoke("terminal-write", owner, "ls\r", "chat-b");
			expect(shellB.write).toHaveBeenCalledWith("ls\r");
			expect(shellA.write).not.toHaveBeenCalled();

			shellA.emitData("from a");
			expect(owner.send).toHaveBeenCalledWith("terminal-data", "from a", "chat-a");
			shellB.emitExit({ exitCode: 3 });
			expect(owner.send).toHaveBeenCalledWith("terminal-exit", { exitCode: 3, signal: undefined, chat: "chat-b" });

			// Closing one chat's shell leaves the other running.
			invoke("terminal-dispose", owner, "chat-a");
			expect(shellA.kill).toHaveBeenCalledOnce();
			expect(shellB.kill).not.toHaveBeenCalled();
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("past the cap, closes the shell quiet the longest and tells the panel which chat's it was", () => {
		const shells = Array.from({ length: MAX_SHELLS_PER_WINDOW + 1 }, () => fakePty());
		for (const shell of shells) mocks.spawn.mockReturnValueOnce(shell);
		const owner = new FakeOwner(60);
		const clock = vi.spyOn(Date, "now");
		try {
			for (let i = 0; i < MAX_SHELLS_PER_WINDOW; i++) {
				clock.mockReturnValue(1_000 + i);
				invoke("terminal-create", owner, 80, 24, `chat-${i}`);
			}
			// chat-0 is the oldest, but it has just printed: chat-1 is the quiet one.
			clock.mockReturnValue(5_000);
			shells[0].emitData("still working");
			clock.mockReturnValue(6_000);
			invoke("terminal-create", owner, 80, 24, "chat-new");

			expect(shells[1].kill).toHaveBeenCalledOnce();
			expect(shells[0].kill).not.toHaveBeenCalled();
			expect(owner.send).toHaveBeenCalledWith("terminal-exit", { exitCode: 0, chat: "chat-1", closed: true });
			expect(mocks.spawn).toHaveBeenCalledTimes(MAX_SHELLS_PER_WINDOW + 1);
		} finally {
			clock.mockRestore();
		}
	});

	it("closes every chat's shell when the window goes", () => {
		const shellA = fakePty();
		const shellB = fakePty();
		mocks.spawn.mockReturnValueOnce(shellA).mockReturnValueOnce(shellB);
		const owner = new FakeOwner(70);
		invoke("terminal-create", owner, 80, 24, "chat-a");
		invoke("terminal-create", owner, 80, 24, "chat-b");
		owner.emit("destroyed");
		expect(shellA.kill).toHaveBeenCalledOnce();
		expect(shellB.kill).toHaveBeenCalledOnce();
		expect(owner.listenerCount("destroyed")).toBe(0);
	});

	it("limits control to the sender and cleans up idempotently", () => {
		const terminal = fakePty();
		mocks.spawn.mockReturnValue(terminal);
		const owner = new FakeOwner(30);
		const other = new FakeOwner(31);
		invoke("terminal-create", owner, 80, 24);

		invoke("terminal-write", other, "ignored");
		invoke("terminal-write", owner, "dir\r");
		invoke("terminal-resize", owner, 9999, -5);
		invoke("terminal-dispose", owner);
		invoke("terminal-dispose", owner);

		expect(terminal.write).toHaveBeenCalledOnce();
		expect(terminal.write).toHaveBeenCalledWith("dir\r");
		expect(terminal.resize).toHaveBeenCalledWith(500, 1);
		expect(terminal.kill).toHaveBeenCalledOnce();
	});

	it("disposes when the renderer is destroyed", () => {
		const terminal = fakePty();
		mocks.spawn.mockReturnValue(terminal);
		const owner = new FakeOwner(40);
		invoke("terminal-create", owner, 80, 24);
		owner.emit("destroyed");
		expect(terminal.kill).toHaveBeenCalledOnce();
	});
});

describe("spawn-helper exec-bit self-heal", () => {
	const itUnix = process.platform === "win32" ? it.skip : it;

	itUnix("restores a stripped execute bit on the platform spawn-helper", () => {
		const root = mkdtempSync(join(tmpdir(), "pty-helper-"));
		try {
			const helperDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
			mkdirSync(helperDir, { recursive: true });
			const helper = join(helperDir, "spawn-helper");
			writeFileSync(helper, "#!/bin/sh\n");
			chmodSync(helper, 0o644);

			ensureSpawnHelperExecutable(() => root);

			expect(statSync(helper).mode & 0o111).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	itUnix("swallows a missing helper (source builds have none)", () => {
		expect(() => ensureSpawnHelperExecutable(() => "/nonexistent-pty-dir")).not.toThrow();
	});
});

describe("terminal IPC validation", () => {
	it("rejects invalid writes and clamps finite dimensions", () => {
		expect(validateTerminalWrite("echo hello\r")).toBe("echo hello\r");
		expect(() => validateTerminalWrite(42)).toThrow(TypeError);
		expect(() => validateTerminalWrite("x".repeat(1024 * 1024 + 1))).toThrow(RangeError);
		expect(validateTerminalSize(120.9, 9999)).toEqual({ cols: 120, rows: 200 });
		expect(() => validateTerminalSize(Number.NaN, 40)).toThrow(TypeError);
	});

	it("reads the chat a call is for, and where its shell starts", () => {
		expect([validateTerminalChat(undefined), validateTerminalChat(null), validateTerminalChat("chat-a")]).toEqual(["", "", "chat-a"]);
		expect(() => validateTerminalChat(7)).toThrow(TypeError);
		expect(() => validateTerminalChat("x".repeat(201))).toThrow(RangeError);
		const here = mkdtempSync(join(tmpdir(), "pty-start-"));
		try {
			writeFileSync(join(here, "file.txt"), "x");
			expect(terminalStartFolder(here, "fallback")).toBe(here);
			expect(terminalStartFolder(join(here, "file.txt"), "fallback")).toBe("fallback"); // a file is no folder
			expect(terminalStartFolder("relative/path", "fallback")).toBe("fallback");
			expect(terminalStartFolder(null, "fallback")).toBe("fallback");
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});
});
