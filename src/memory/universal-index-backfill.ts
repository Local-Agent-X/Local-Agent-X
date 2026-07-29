/**
 * Backfill walk for the universal index — "visit every store, reindex what
 * changed". Split out of universal-index.ts (one responsibility per file)
 * when the walk was moved off the event loop's critical path.
 *
 * MEASURED, on the running app: the boot backfill (background-jobs fires it
 * shortly after the port starts listening) issued ~750k SYNCHRONOUS reads —
 * 3.6 GB — at ~0% CPU. The event loop went silent for minutes, the UI never
 * became usable, and the app had to be force-quit. This is the same lesson
 * index-search/vector-search-worker.ts already records in its header ("froze
 * the whole server when it ran on the main loop"), never applied here.
 *
 * WHY NOT THE WORKER PATTERN vector-search uses: that scan is separable — a
 * db path in, scored rows out, with a self-contained copy of the math. This
 * walk is not. Every file's chunks go through MemoryIndex's live
 * better-sqlite3 handle and the configured embedding provider, and neither a
 * db handle nor a provider crosses a worker boundary; a second writer on
 * memory.db would only move the stall (the main thread would then block on
 * busy_timeout). A worker entry also cannot import project modules (see that
 * same header), so it would have to FORK the canonical chunker rather than
 * extend it. So the walk stays in-process and instead:
 *   - lists directories through fs/promises, so the read runs off-thread, and
 *   - hands the loop back between EVERY file via the memory subsystem's
 *     canonical yieldEventLoop(), so however many files exist the loop is
 *     never held for longer than a single one of them.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { yieldEventLoop } from "./index-embedding-reconcile.js";
import type { CanonicalSource } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.universal-index-backfill");

export interface IndexResult {
  added: number;
  removed: number;
  unchanged: number;
}

export interface BackfillReport {
  bySource: Partial<Record<CanonicalSource, { filesScanned: number; chunksAdded: number; chunksUnchanged: number }>>;
  totalFilesScanned: number;
  totalChunksAdded: number;
  totalChunksUnchanged: number;
  durationMs: number;
}

/** The four store roots the walk visits. */
export interface BackfillDirs {
  entities: string;
  memory: string;
  summaries: string;
  sessions: string;
}

/** The per-file indexers the walk drives. UniversalIndex implements this —
 *  the walk owns iteration + pacing only, never how a file is chunked. */
export interface BackfillIndexers {
  indexEntityPage(slug: string): Promise<IndexResult>;
  indexDailyLog(date?: Date): Promise<IndexResult>;
  indexSessionSummary(sessionId: string): Promise<IndexResult>;
  indexSessionTranscript(sessionId: string): Promise<IndexResult>;
  indexPersonalityFile(filename: string): Promise<IndexResult>;
}

export interface BackfillOptions {
  force?: boolean;
  /** Clears path-level idempotency so the indexers re-insert from scratch.
   *  Owned by the caller because it reaches into the MemoryIndex db handle. */
  forceClear?: () => void;
}

/** Regular files in `dir` ending in `ext`; empty when the dir doesn't exist. */
async function listFiles(dir: string, ext: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => e.name);
}

export async function runBackfill(
  dirs: BackfillDirs,
  indexers: BackfillIndexers,
  opts?: BackfillOptions,
): Promise<BackfillReport> {
  const t0 = Date.now();
  const report: BackfillReport = {
    bySource: {},
    totalFilesScanned: 0,
    totalChunksAdded: 0,
    totalChunksUnchanged: 0,
    durationMs: 0,
  };

  const accum = (src: CanonicalSource, res: IndexResult) => {
    const slot = report.bySource[src] || { filesScanned: 0, chunksAdded: 0, chunksUnchanged: 0 };
    slot.filesScanned += 1;
    slot.chunksAdded += res.added;
    slot.chunksUnchanged += res.unchanged;
    report.bySource[src] = slot;
    report.totalFilesScanned += 1;
    report.totalChunksAdded += res.added;
    report.totalChunksUnchanged += res.unchanged;
  };

  if (opts?.force) opts.forceClear?.();

  // Entity pages
  for (const f of await listFiles(dirs.entities, ".md")) {
    const slug = basename(f, ".md");
    try { accum("entity", await indexers.indexEntityPage(slug)); }
    catch (e) { logger.warn(`[universal-index] entity ${slug}:`, (e as Error).message); }
    await yieldEventLoop();
  }

  // Memory root files: daily logs and personality files.
  for (const name of await listFiles(dirs.memory, ".md")) {
    try {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
        const dateStr = name.replace(".md", "");
        accum("daily-log", await indexers.indexDailyLog(new Date(dateStr)));
      } else {
        accum("personality", await indexers.indexPersonalityFile(name));
      }
    } catch (e) {
      logger.warn(`[universal-index] ${name}:`, (e as Error).message);
    }
    await yieldEventLoop();
  }

  // Session summaries
  for (const f of await listFiles(dirs.summaries, ".md")) {
    const sessionId = basename(f, ".md");
    try { accum("session-summary", await indexers.indexSessionSummary(sessionId)); }
    catch (e) { logger.warn(`[universal-index] summary ${sessionId}:`, (e as Error).message); }
    await yieldEventLoop();
  }

  // Raw session transcripts — the retroactive fix for pre-pipeline sessions.
  // Walks ~/.lax/sessions/*.jsonl and reindexes every transcript via the
  // idempotent path. Hash-deduped, so already-indexed sessions cost ~nothing.
  for (const f of await listFiles(dirs.sessions, ".jsonl")) {
    const sessionId = basename(f, ".jsonl");
    try { accum("session", await indexers.indexSessionTranscript(sessionId)); }
    catch (e) { logger.warn(`[universal-index] session ${sessionId}:`, (e as Error).message); }
    await yieldEventLoop();
  }

  report.durationMs = Date.now() - t0;
  return report;
}
