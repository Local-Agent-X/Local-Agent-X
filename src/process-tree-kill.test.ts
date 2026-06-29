import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { killProcessGroup } from "./process-tree-kill.js";

// Regression guard for the load-bearing platform logic in killProcessGroup.
// The three detached-spawn sites (process-session killSession + killWinPid, the
// shell tool's abort handler) rely on it killing the whole process GROUP. A
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
