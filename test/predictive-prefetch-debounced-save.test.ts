/**
 * Regression suite for AM-5: learnSchedule ran on EVERY message (via the
 * predictive-prefetch background signal's `record` hook) and synchronously
 * rewrote the entire pretty-printed 2000-entry schedule-profile.json —
 * a ~394KB disk write inside the turn path, per message.
 *
 * The invariant pinned here: the turn path (learnSchedule) never touches
 * disk. Persistence is debounced — buffered mutations reach disk only via
 * the coalescing timer or an explicit flush(), and are written compact.
 *
 * predictive-prefetch.ts captures its profile path from getLaxDir() at
 * module load, so each test gets a fresh module (vi.resetModules) with
 * LAX_DATA_DIR pointing at a per-test tempdir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PredictivePrefetcher } from "../src/cognition/predictive-prefetch.js";

let tmpRoot: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-prefetch-test-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmpRoot;
});

afterEach(() => {
  vi.useRealTimers();
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function freshPrefetcher(): Promise<PredictivePrefetcher> {
  vi.resetModules();
  const mod = await import("../src/cognition/predictive-prefetch.js");
  return mod.PredictivePrefetcher.getInstance();
}

const profilePath = () => join(tmpRoot, "schedule-profile.json");

describe("PredictivePrefetcher debounced persistence (AM-5)", () => {
  it("learnSchedule never writes to disk on the turn path", async () => {
    const pp = await freshPrefetcher();

    for (let i = 0; i < 25; i++) {
      pp.learnSchedule(Date.now(), [`topic${i}`, "deploy"], ["entity"]);
    }

    // Pre-fix: the full store was rewritten synchronously on the FIRST call.
    expect(existsSync(profilePath())).toBe(false);

    pp.flush();
    expect(existsSync(profilePath())).toBe(true);
    const raw = readFileSync(profilePath(), "utf-8");
    expect(JSON.parse(raw).entries).toHaveLength(25);
    // Written compact, not pretty-printed.
    expect(raw).not.toContain("\n");
  });

  it("the debounce timer persists buffered entries without an explicit flush", async () => {
    vi.useFakeTimers();
    const pp = await freshPrefetcher();

    pp.learnSchedule(Date.now(), ["standup"], []);
    expect(existsSync(profilePath())).toBe(false);

    vi.advanceTimersByTime(6_000);
    expect(existsSync(profilePath())).toBe(true);
    expect(JSON.parse(readFileSync(profilePath(), "utf-8")).entries).toHaveLength(1);
  });

  it("flushed data survives a reload in a fresh instance", async () => {
    const pp = await freshPrefetcher();
    pp.learnSchedule(Date.now(), ["review"], ["pr-42"]);
    pp.flush();

    const reloaded = await freshPrefetcher();
    expect(reloaded.getScheduleProfile().totalDataPoints).toBe(1);
  });

  it("flush is idempotent when nothing is buffered", async () => {
    const pp = await freshPrefetcher();
    pp.flush();
    expect(existsSync(profilePath())).toBe(false);
  });
});
