// Pid-probe regression tests. Background: a stale pidfile from a previous
// run pointing at a recycled PID used to read as "our server is alive",
// driving the launcher into an infinite crash loop. The image-name check
// in isOurServerProcess is what catches that.

import { describe, it, expect } from "vitest";
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
  it("returns true for the test process's own PID (vitest runs in node)", () => {
    expect(isOurServerProcess(process.pid)).toBe(true);
  });

  it("returns false for an unassigned PID", () => {
    expect(isOurServerProcess(UNASSIGNED_PID)).toBe(false);
  });

  // The recycled-PID case (alive, but the image isn't node) is what
  // motivated this fix. We can't synthesize one portably — we'd need a
  // long-lived non-node process at a known PID. The probe is exercised
  // end-to-end at boot whenever a pidfile exists.
});
