/**
 * The backfill walk must never monopolise the event loop.
 *
 * Live bug this pins: the boot backfill walked the corpus with synchronous
 * reads and only microtask-level awaits between files, so the loop went
 * silent for minutes — nothing else could run and the UI never became
 * usable. Same lesson index-search/vector-search-worker.ts records for the
 * vector scan.
 *
 * These assert the MECHANISM (the loop actually regains control between
 * files), never wall-clock timing: a macrotask armed while the walk is in
 * flight can only run if the walk hands the loop back, and it can only be
 * observed at several DISTINCT file counts if it hands it back per file
 * rather than once per directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfill, type BackfillIndexers, type IndexResult } from "./universal-index-backfill.js";

const NONE: IndexResult = { added: 0, removed: 0, unchanged: 0 };
const ONE: IndexResult = { added: 1, removed: 0, unchanged: 0 };

let tempDir: string;
let entitiesDir: string;
/** Slugs handed to the indexer, in order — the walk's progress counter. */
let indexed: string[];

const dirs = () => ({
  entities: entitiesDir,
  memory: join(tempDir, "memory"),
  summaries: join(tempDir, "memory", "session-summaries"),
  sessions: join(tempDir, "sessions"),
});

const indexers = (): BackfillIndexers => ({
  indexEntityPage: async (slug) => { indexed.push(slug); return ONE; },
  indexDailyLog: async () => NONE,
  indexSessionSummary: async () => NONE,
  indexSessionTranscript: async () => NONE,
  indexPersonalityFile: async () => NONE,
});

const FILE_COUNT = 6;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-uidx-bf-"));
  entitiesDir = join(tempDir, "memory", "bank", "entities");
  mkdirSync(entitiesDir, { recursive: true });
  indexed = [];
  // One store only, so a per-DIRECTORY hand-off cannot be mistaken for a
  // per-FILE one: every observation below happens inside a single readdir.
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(entitiesDir, `e${i}.md`), `# E${i}\n\n- fact ${i}\n`, "utf-8");
  }
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("runBackfill event-loop pacing", () => {
  it("hands the loop back between files, not just between directories", async () => {
    const observedAt: number[] = [];
    let walking = true;
    // Re-arming macrotask: each run records how far the walk had got. It can
    // only ever run while `walking` is true if the walk yields.
    const probe = () => {
      if (!walking) return;
      observedAt.push(indexed.length);
      setImmediate(probe);
    };

    const walk = runBackfill(dirs(), indexers());
    setImmediate(probe);
    const report = await walk;
    walking = false;

    expect(report.totalFilesScanned).toBe(FILE_COUNT);
    expect(indexed.length).toBe(FILE_COUNT);

    // The loop ran at several distinct points strictly inside the walk. With
    // the files processed back-to-back this set is empty: the only sample
    // possible is 0 (before the first file) or FILE_COUNT (after the last).
    const midWalk = new Set(observedAt.filter((n) => n > 0 && n < FILE_COUNT));
    expect(midWalk.size).toBeGreaterThanOrEqual(3);
  });

  it("still reports every file it scanned", async () => {
    const report = await runBackfill(dirs(), indexers());
    expect(report.totalChunksAdded).toBe(FILE_COUNT);
    expect(report.bySource.entity).toMatchObject({ filesScanned: FILE_COUNT, chunksAdded: FILE_COUNT });
    expect(indexed.sort()).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
  });

  it("keeps walking when one file's indexer throws, and yields past it", async () => {
    const failing: BackfillIndexers = {
      ...indexers(),
      indexEntityPage: async (slug) => {
        indexed.push(slug);
        if (slug === "e2") throw new Error("boom");
        return ONE;
      },
    };
    const report = await runBackfill(dirs(), failing);
    expect(indexed.length).toBe(FILE_COUNT);
    expect(report.totalFilesScanned).toBe(FILE_COUNT - 1); // the thrower isn't accumulated
  });

  it("skips absent stores without throwing", async () => {
    rmSync(entitiesDir, { recursive: true, force: true });
    const report = await runBackfill(dirs(), indexers());
    expect(report.totalFilesScanned).toBe(0);
    expect(indexed).toEqual([]);
  });
});
