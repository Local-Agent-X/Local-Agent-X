// Pid-probe regression tests. Background: a stale pidfile from a previous
// run pointing at a recycled PID used to read as "our server is alive",
// driving the launcher into an infinite crash loop. The image-name check
// in isOurServerProcess is what catches that.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { isPidAlive, isOurServerProcess } from "./pid-probe.js";

// A PID we're confident is not assigned. Real PIDs on Windows fit in
// 32-bit but the OS won't allocate values this high in practice; on Linux
// the default pid_max is 32768.
const UNASSIGNED_PID = 999_999_999;

describe("isPidAlive", () => {
  it("returns true for the test process's own PID", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an unassigned PID", () => {
    expect(isPidAlive(UNASSIGNED_PID)).toBe(false);
  });

  it("returns false for non-integer / zero / negative input", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

describe("isOurServerProcess", () => {
  it("returns true for a real (untitled) node process", async () => {
    // Can't probe our own PID: vitest rewrites this worker's process.title and
    // macOS `ps -o comm=` surfaces that title instead of "node". Spawn a plain
    // node child (no title rewrite) and probe it — that's the contract that
    // matters: a genuine node process reads as ours.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const pid = child.pid!;
      // ps may not see the exec'd image for a few ms after spawn; poll briefly.
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        if (isOurServerProcess(pid)) ok = true;
        else await new Promise((r) => setTimeout(r, 25));
      }
      expect(ok).toBe(true);
    } finally {
      child.kill();
    }
  });

  it("returns false for an unassigned PID", () => {
    expect(isOurServerProcess(UNASSIGNED_PID)).toBe(false);
  });

  // The recycled-PID case (alive, but the image isn't node) is what
  // motivated this fix. We can't synthesize one portably — we'd need a
  // long-lived non-node process at a known PID. The probe is exercised
  // end-to-end at boot whenever a pidfile exists.
});
