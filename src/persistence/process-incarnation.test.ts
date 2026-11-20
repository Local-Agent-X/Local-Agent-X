// The one check a lock or claim makes before taking over from its holder.
// Windows reuses pids quickly, so a pid alone said a dead holder's lock was
// still held whenever another program had its pid.
import { describe, it, expect } from "vitest";
import { currentProcessIncarnation, processAlive } from "./process-incarnation.js";

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
