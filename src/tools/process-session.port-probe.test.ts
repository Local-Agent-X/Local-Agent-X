// The port probe's contract: an OS lookup that fails answers null, never [].
// Every caller that kills or restarts on "nothing listening" reads the
// difference; an empty answer from a timed-out netstat used to read as a free
// port and restart a healthy dev server.
import { describe, expect, it, vi } from "vitest";

const os = vi.hoisted(() => ({ table: "" as string, fail: false }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: () => {
    if (os.fail) throw new Error("ETIMEDOUT");
    return os.table;
  },
}));

import { isPortBound, pidsOnPort } from "./process-session.js";

const LISTENING_5180 = process.platform === "win32"
  ? "  TCP    0.0.0.0:5180           0.0.0.0:0              LISTENING       4242\n"
  : "4242\n";

describe("pidsOnPort / isPortBound", () => {
  it("names the listener when the OS answers", () => {
    os.fail = false;
    os.table = LISTENING_5180;
    expect(pidsOnPort(5180)).toEqual([4242]);
    expect(isPortBound(5180)).toBe(true);
  });

  it("answers [] / false when the OS lists no listener", () => {
    os.fail = false;
    os.table = "";
    expect(pidsOnPort(5180)).toEqual([]);
    expect(isPortBound(5180)).toBe(false);
  });

  it("answers null when the OS lookup itself fails", () => {
    os.fail = true;
    expect(pidsOnPort(5180)).toBeNull();
    expect(isPortBound(5180)).toBeNull();
  });

  it("an invalid port has no listeners, whatever the OS would say", () => {
    os.fail = true;
    expect(pidsOnPort(0)).toEqual([]);
  });
});
