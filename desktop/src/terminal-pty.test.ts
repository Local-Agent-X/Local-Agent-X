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

import { disposeAllTerminals, ensureSpawnHelperExecutable, setupTerminalIPC, validateTerminalSize, validateTerminalWrite } from "./terminal-pty";

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
		expect(ownerA.send).toHaveBeenCalledWith("terminal-data", "A");
		expect(ownerA.send).not.toHaveBeenCalledWith("terminal-data", "B");
		expect(ownerB.send).toHaveBeenCalledWith("terminal-data", "B");
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
});
