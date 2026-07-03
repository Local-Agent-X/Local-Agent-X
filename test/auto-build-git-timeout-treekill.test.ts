/**
 * gitRun timeout must kill the whole process TREE, not just the spawned proc.
 *
 * Regression (AB-5): gitRun spawns with shell:true on Windows, so the
 * timeout's proc.kill("SIGTERM") terminated only the cmd.exe wrapper — the
 * real git kept running holding .git/index.lock, and the immediate
 * build_plan_resume then failed every git op until the orphan exited.
 * The timeout must route through the canonical killProcessTree
 * (src/process-tree-kill.ts), which taskkills the tree on Windows.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const killProcessTreeMock = vi.fn();
vi.mock("../src/process-tree-kill.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

import { getHeadSha } from "../src/auto-build/git-helpers.js";

/** A spawned git that never finishes on its own — only dies when killed. */
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  pid = 4242;
  // Pre-fix behavior: plain kill "succeeds" (the wrapper dies) but on
  // Windows the real git would live on. Emitting close here means the
  // pre-fix code still settles its promise — the discriminator below is
  // whether killProcessTree was invoked, not whether the promise hangs.
  kill = vi.fn((_signal?: string) => { this.emit("close", null); return true; });
}

describe("gitRun timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("kills the whole process tree via killProcessTree, not just the shell wrapper", async () => {
    vi.useFakeTimers();
    const proc = new FakeProc();
    spawnMock.mockReturnValue(proc);
    // Simulate the tree actually dying when tree-killed.
    killProcessTreeMock.mockImplementation((p: FakeProc) => { p.emit("close", null); });

    const pending = getHeadSha("/some/project").then(
      () => { throw new Error("expected getHeadSha to reject on timeout"); },
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(killProcessTreeMock).toHaveBeenCalledWith(proc);

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out/);
  });
});
