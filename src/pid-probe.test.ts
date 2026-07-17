// Pid-probe regression tests. Background: a stale pidfile from a previous
// run pointing at a recycled PID used to read as "our server is alive",
// driving the launcher into an infinite crash loop. The image-name check
// in isOurServerProcess is what catches that.

import { beforeEach, describe, expect, it, vi } from "vitest";

const processImageMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: processImageMocks.execSync,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: processImageMocks.readFileSync,
  readlinkSync: processImageMocks.readlinkSync,
}));

import { isPidAlive, isOurServerProcess } from "./pid-probe.js";

// A PID we're confident is not assigned. Real PIDs on Windows fit in
// 32-bit but the OS won't allocate values this high in practice; on Linux
// the default pid_max is 32768.
const UNASSIGNED_PID = 999_999_999;

function mockProcessImage(image: string | null): void {
  if (process.platform === "win32") {
    const output = image
      ? `"${image}","${process.pid}","Console","1","10,000 K"\r\n`
      : "INFO: No tasks are running which match the specified criteria.\r\n";
    processImageMocks.execSync.mockReturnValue(Buffer.from(output));
    return;
  }
  if (process.platform === "linux") {
    if (image) {
      processImageMocks.readlinkSync.mockReturnValue(`/usr/bin/${image}`);
    } else {
      processImageMocks.readlinkSync.mockImplementation(() => { throw new Error("denied"); });
      processImageMocks.readFileSync.mockReturnValue("");
    }
    return;
  }
  processImageMocks.execSync.mockReturnValue(
    Buffer.from(image ? `/usr/local/bin/${image}\n` : ""),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it.each(["node", "NODE.EXE"])("returns true for a live %s process", (image) => {
    mockProcessImage(image);

    expect(isOurServerProcess(process.pid)).toBe(true);
  });

  it("returns false when a live PID belongs to an unrelated process", () => {
    mockProcessImage(process.platform === "win32" ? "chrome.exe" : "chrome");

    expect(isPidAlive(process.pid)).toBe(true);
    expect(isOurServerProcess(process.pid)).toBe(false);
  });

  it("returns false when a live process image cannot be inspected", () => {
    mockProcessImage(null);

    expect(isOurServerProcess(process.pid)).toBe(false);
  });

  it("returns false for an unassigned PID", () => {
    expect(isOurServerProcess(UNASSIGNED_PID)).toBe(false);
  });
});
