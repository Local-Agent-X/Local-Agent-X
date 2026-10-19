import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { killOrphansOfSync, killProcessGroup, killProcessGroupSync } from "./process-tree-kill.js";

// Regression guard for the load-bearing platform logic in killProcessGroup.
// The detached-spawn sites (process-session killSession, the shell tool's
// abort handler) rely on it killing the whole process GROUP. A
// regression to a plain single-pid kill would silently ORPHAN child processes
// (shells, dev servers) — the exact silent break this test exists to catch.
//
// POSIX-focused: the negative-pid group kill is POSIX-specific and is the part
// most likely to be "simplified" wrongly. The win32 branch (`taskkill /F /T`)
// lives in one place (asserted by the single-call-site grep) and is skipped here
// to avoid signalling real processes / module-mocking in CI.
describe("killProcessGroup", () => {
  afterEach(() => vi.restoreAllMocks());

  it.skipIf(process.platform === "win32")(
    "POSIX: signals the whole process GROUP via negative pid (so detached children don't orphan)",
    () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      killProcessGroup(4321);
      // -pid targets the group; a regression to kill(4321) would leave the
      // detached children alive. This assertion fails the moment that happens.
      expect(killSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
    },
  );

  it.skipIf(process.platform === "win32")(
    "POSIX: falls back to killing just the child when the group kill throws (pid wasn't a group leader)",
    () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      const child = { kill: vi.fn() } as unknown as ChildProcess;
      killProcessGroup(4321, child);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it.skipIf(process.platform === "win32")(
    "never throws when the group kill fails and there is no fallback child",
    () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      expect(() => killProcessGroup(4321)).not.toThrow();
    },
  );
});

// killProcessGroupSync must be usable from a process.on("exit") handler, where
// the event loop is drained and an async spawn'd taskkill never runs — the gap
// that orphaned dev-server children past a graceful LAX quit (they kept their
// ports and fed the lazy-restart storm). Unlike the mocked group-kill specs
// above, this spawns a real (benign, self-owned) child: the sync/async split is
// exactly the part a mock can't see.
describe("killProcessGroupSync", () => {
  const isRunning = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it("terminates a live detached child before returning control", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    expect(pid).toBeTruthy();
    expect(isRunning(pid!)).toBe(true);

    killProcessGroupSync(pid!, child);

    // The kill is synchronous but the OS may take a beat to reap; poll briefly.
    const deadline = Date.now() + 3000;
    while (isRunning(pid!) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isRunning(pid!)).toBe(false);
  }, 10_000);

  it("never throws on an already-dead pid", () => {
    expect(() => killProcessGroupSync(999_999_999)).not.toThrow();
  });
});

// A sync runner (execFileSync/spawnSync) kills its own child on timeout and
// leaves that child's children running; on Windows they keep the dead pid as
// their parent. A real parent here, killed the way the runner kills it, with a
// child of its own left behind.
describe.skipIf(process.platform !== "win32")("killOrphansOfSync", () => {
  const isRunning = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  // Detached, so the parent's own job object does not take the child with it.
  const parentScript =
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"],` +
    ` { detached: true, stdio: "ignore", windowsHide: true }); c.unref(); console.log(c.pid); setInterval(()=>{},1000);`;

  async function orphan(): Promise<{ parentPid: number; childPid: number; startedAt: number; endedAt: number }> {
    const startedAt = Date.now();
    const parent = spawn(process.execPath, ["-e", parentScript], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((resolve) => parent.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
    const exited = new Promise((resolve) => parent.once("exit", resolve));
    parent.kill();
    await exited;
    return { parentPid: parent.pid!, childPid, startedAt, endedAt: Date.now() };
  }

  it("kills what a dead process left running, and returns once it is gone", async () => {
    const { parentPid, childPid, startedAt, endedAt } = await orphan();
    expect(isRunning(childPid)).toBe(true);
    killOrphansOfSync(parentPid, startedAt, endedAt);
    expect(isRunning(childPid)).toBe(false);
  }, 30_000);

  it("leaves a process created outside the call alone (the pid may have been reused)", async () => {
    const { parentPid, childPid, endedAt } = await orphan();
    try {
      killOrphansOfSync(parentPid, endedAt, endedAt + 1);
      expect(isRunning(childPid)).toBe(true);
    } finally {
      try { process.kill(childPid); } catch { /* already gone */ }
    }
  }, 30_000);
});
