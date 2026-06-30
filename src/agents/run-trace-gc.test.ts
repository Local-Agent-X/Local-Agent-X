/**
 * run-trace GC tests — retention bounds for ~/.lax/run-traces.
 *
 * TRACES_DIR is bound at module-load from getLaxDir(), so each test gets its
 * own throwaway dir by pointing LAX_DATA_DIR at a temp path and re-importing
 * the module fresh (vi.resetModules + dynamic import). This keeps the sweep
 * from ever touching the developer's real ~/.lax/run-traces.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let mod: typeof import("./run-trace.js");
const prevEnv = process.env.LAX_DATA_DIR;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lax-trace-gc-"));
  process.env.LAX_DATA_DIR = dir;
  vi.resetModules();
  mod = await import("./run-trace.js");
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Write a trace file directly into TRACES_DIR with a controlled mtime.
function seedTrace(runId: string, ageMs: number, now: number): string {
  if (!existsSync(mod.TRACES_DIR)) mkdirSync(mod.TRACES_DIR, { recursive: true });
  const p = join(mod.TRACES_DIR, `${runId}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: "run_end", runId, ts: now, status: "ok" }) + "\n", "utf-8");
  const t = new Date(now - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe("gcTraces — age bound", () => {
  it("removes files older than maxAgeMs and keeps fresh ones", () => {
    const now = 1_000_000_000_000;
    // run_start writes the dir; ensure it exists first.
    mod.appendTraceEvent("seed", { type: "run_start", runId: "seed", ts: now, role: "r", task: "t" });
    const old = seedTrace("old", 40 * 24 * 60 * 60 * 1000, now);   // 40d → over 30d
    const fresh = seedTrace("fresh", 1 * 60 * 60 * 1000, now);     // 1h → keep

    const removed = mod.gcTraces({ now });
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("gcTraces — count bound", () => {
  it("keeps only the newest maxFiles, oldest dropped first", () => {
    const now = 1_000_000_000_000;
    // 5 traces, each older than the last by 1 minute.
    const paths = [0, 1, 2, 3, 4].map((i) => seedTrace(`run-${i}`, i * 60_000, now));

    const removed = mod.gcTraces({ maxFiles: 2, maxAgeMs: 0, now });
    expect(removed).toBe(3);
    // Newest two (smallest age) survive; the three oldest are gone.
    expect(existsSync(paths[0])).toBe(true);
    expect(existsSync(paths[1])).toBe(true);
    expect(existsSync(paths[2])).toBe(false);
    expect(existsSync(paths[3])).toBe(false);
    expect(existsSync(paths[4])).toBe(false);
  });
});

describe("gcTraces — wired at run_start", () => {
  it("a new run sweeps stale traces but never deletes its own fresh file", () => {
    const now = Date.now();
    const stale = seedTrace("stale", 40 * 24 * 60 * 60 * 1000, now);

    // run_start triggers gcTraces() internally with default bounds.
    mod.appendTraceEvent("active-run", { type: "run_start", runId: "active-run", ts: now, role: "r", task: "t" });

    expect(existsSync(stale)).toBe(false);                  // stale swept
    expect(mod.readTrace("active-run")).toHaveLength(1);    // own trace intact
  });
});

describe("gcTraces — resilience", () => {
  it("returns 0 and never throws when the dir does not exist", () => {
    rmSync(mod.TRACES_DIR, { recursive: true, force: true });
    expect(existsSync(mod.TRACES_DIR)).toBe(false);
    expect(() => mod.gcTraces()).not.toThrow();
    expect(mod.gcTraces()).toBe(0);
  });

  it("ignores non-.jsonl files in the directory", () => {
    const now = 1_000_000_000_000;
    mod.appendTraceEvent("seed", { type: "run_start", runId: "seed", ts: now, role: "r", task: "t" });
    const stray = join(mod.TRACES_DIR, "notes.txt");
    writeFileSync(stray, "not a trace", "utf-8");

    mod.gcTraces({ maxFiles: 1, maxAgeMs: 0, now });
    expect(existsSync(stray)).toBe(true); // untouched — only *.jsonl are swept
    // and the dir wasn't blown away
    expect(readdirSync(mod.TRACES_DIR)).toContain("notes.txt");
  });
});
