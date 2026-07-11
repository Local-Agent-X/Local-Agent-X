import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway dir BEFORE importing the module — getLaxDir()
// reads LAX_DATA_DIR per call, so recordP1Outcome writes here, never ~/.lax.
let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "p1-metrics-"));
  process.env.LAX_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("p1-metrics durable store", () => {
  it("defaults to zeroed counts when the file is absent", async () => {
    const { readP1Metrics } = await import("./p1-metrics.js");
    expect(readP1Metrics()).toEqual({ terminated: 0, reopenedByGate: 0, firstSeen: "", lastSeen: "" });
  });

  it("accumulates counts across calls and persists to disk (survives a fresh read)", async () => {
    const { recordP1Outcome, readP1Metrics } = await import("./p1-metrics.js");
    recordP1Outcome("terminated");
    recordP1Outcome("terminated");
    recordP1Outcome("reopened-by-gate");

    // The file exists on disk — the whole point is surviving a restart.
    expect(existsSync(join(dir, "p1-metrics.json"))).toBe(true);

    const m = readP1Metrics();
    expect(m.terminated).toBe(2);
    expect(m.reopenedByGate).toBe(1);
    expect(m.firstSeen).not.toBe("");
    expect(m.lastSeen).not.toBe("");
    expect(m.lastSeen >= m.firstSeen).toBe(true);
  });

  it("recovers from a corrupt file instead of throwing into the turn path", async () => {
    writeFileSync(join(dir, "p1-metrics.json"), "{ not json", "utf-8");
    const { recordP1Outcome, readP1Metrics } = await import("./p1-metrics.js");
    // Must not throw (behavior-neutral); corrupt file resets to defaults + records.
    expect(() => recordP1Outcome("terminated")).not.toThrow();
    expect(readP1Metrics().terminated).toBe(1);
  });
});
