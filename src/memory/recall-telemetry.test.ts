/**
 * Tests for the memory-recall telemetry sidecar (recall-telemetry.ts).
 *
 * Contract: append-only JSONL under <lax-dir>/telemetry — restart-safe by
 * construction (each event is one flushed line on disk; nothing is held in
 * memory), lazy path resolution so LAX_DATA_DIR overrides are honored per
 * call, and logging must never throw.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logMemoryRecall } from "./recall-telemetry.js";

let tempDir: string;
let prevLaxDataDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-recall-tel-"));
  prevLaxDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tempDir;
});

afterEach(() => {
  if (prevLaxDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDataDir;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const FILE = () => join(tempDir, "telemetry", "memory-recall.jsonl");

describe("logMemoryRecall", () => {
  it("appends one JSONL line per event with a timestamp", () => {
    logMemoryRecall({
      sessionId: "s1",
      matched: ["merchhelm"],
      factsRendered: 2,
      factsDeduped: 1,
      bytesInjected: 140,
      totalEntities: 12,
      scannedEntities: 12,
    });

    const lines = readFileSync(FILE(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.matched).toEqual(["merchhelm"]);
    expect(event.factsRendered).toBe(2);
    expect(event.factsDeduped).toBe(1);
    expect(event.sessionId).toBe("s1");
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it("accumulates across calls — earlier lines survive later writes (restart-safety contract)", () => {
    logMemoryRecall({ matched: [], factsRendered: 0, factsDeduped: 0, bytesInjected: 0, totalEntities: 5, scannedEntities: 5, cutoffMisses: ["ghost"] });
    logMemoryRecall({ matched: ["a"], factsRendered: 1, factsDeduped: 0, bytesInjected: 40, totalEntities: 5, scannedEntities: 5 });

    const lines = readFileSync(FILE(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).cutoffMisses).toEqual(["ghost"]);
    expect(JSON.parse(lines[1]).matched).toEqual(["a"]);
  });

  it("never throws when the data dir is unwritable", () => {
    process.env.LAX_DATA_DIR = join(tempDir, "does-not-exist", "\0bad");
    expect(() =>
      logMemoryRecall({ matched: [], factsRendered: 0, factsDeduped: 0, bytesInjected: 0, totalEntities: 0, scannedEntities: 0 }),
    ).not.toThrow();
  });
});
