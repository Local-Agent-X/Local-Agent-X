// The one check a lock or claim makes before taking over from its holder.
// Windows reuses pids quickly, so a pid alone said a dead holder's lock was
// still held whenever another program had its pid.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentProcessIncarnation, lockOwnersGone, processAlive, processGone } from "./process-incarnation.js";

const NO_SUCH_PID = 999_999_999;

describe("processGone", () => {
  it("is true only for a pid no process has", () => {
    expect(processGone(NO_SUCH_PID)).toBe(true);
    expect(processGone(process.pid)).toBe(false);
  });

  it("is false for a value that is not a pid: that proves nothing", () => {
    expect(processGone(0)).toBe(false);
    expect(processGone(-5)).toBe(false);
    expect(processGone(1.5)).toBe(false);
  });
});

describe("lockOwnersGone", () => {
  let dir = "";
  const lockWith = (records: Record<string, string>): string[] => {
    dir = mkdtempSync(join(tmpdir(), "lock-owners-"));
    for (const [name, body] of Object.entries(records)) writeFileSync(join(dir, name), body);
    return Object.keys(records);
  };
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("is true when every owner record names a pid that is gone", () => {
    const tokens = lockWith({ a: JSON.stringify({ pid: NO_SUCH_PID }), b: JSON.stringify({ pid: NO_SUCH_PID - 1 }) });
    expect(lockOwnersGone(dir, tokens)).toBe(true);
  });

  it("is false when any owner still has a process, even beside a dead one", () => {
    const tokens = lockWith({ dead: JSON.stringify({ pid: NO_SUCH_PID }), live: JSON.stringify({ pid: process.pid }) });
    expect(lockOwnersGone(dir, tokens)).toBe(false);
  });

  it("is false for a record that cannot be read as an owner, and for no records at all", () => {
    expect(lockOwnersGone(dir = mkdtempSync(join(tmpdir(), "lock-owners-")), [])).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    for (const body of ["", "{", JSON.stringify({ pid: "12" }), JSON.stringify({})]) {
      const tokens = lockWith({ t: body });
      expect(lockOwnersGone(dir, tokens), JSON.stringify(body)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(lockOwnersGone(dir, ["missing-file"])).toBe(false);
  });
});

describe("processAlive", () => {
  it("is true for this process under its own incarnation", () => {
    expect(processAlive(process.pid, currentProcessIncarnation())).toBe(true);
  });

  it("is false for this pid under an earlier process's incarnation (a reused pid)", () => {
    expect(processAlive(process.pid, `${process.pid}:an-earlier-start`)).toBe(false);
  });

  it("judges a record without an incarnation by its pid", () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that is not a process", () => {
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-5)).toBe(false);
    expect(processAlive(2 ** 31 - 2, "x:y")).toBe(false);
  });
});
