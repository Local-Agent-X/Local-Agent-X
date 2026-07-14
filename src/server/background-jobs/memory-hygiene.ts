/**
 * memory-hygiene — daily maintenance for ~/.lax data that nothing else owns.
 *
 * Before this job: embedding_cache was LRU-pruned only during a full memory
 * sync, the WAL was truncated only at boot, and sessions accumulated forever
 * (~3000 files / 347MB observed). This job runs once a day on the foreground-
 * idle gate and does four things:
 *
 *   1. LRU-prune embedding_cache to embeddingCacheMaxEntries (reuses the
 *      canonical pruner from index-embedding — no forked logic).
 *   2. PRAGMA optimize — refresh query-planner stats (before the checkpoint,
 *      since its ANALYZE writes land in the WAL).
 *   3. WAL checkpoint (TRUNCATE) via MemoryIndex.checkpoint(), wrapped in a
 *      short busy_timeout: with a live snapshot reader, wal_checkpoint blocks
 *      synchronously up to busy_timeout (5000ms default) — an idle-time
 *      hygiene pass must never pin the event loop for 5s, so we drop to
 *      100ms for the call and restore afterwards (better-sqlite3 is sync,
 *      so no other statement can interleave with the lowered timeout).
 *   4. Archive sessions older than SESSION_ARCHIVE_MAX_AGE_DAYS to
 *      <dataDir>/sessions-archive/ via SessionStore.archiveOldSessions().
 *      Archived, never deleted — user-decided policy.
 */
import type { SessionStore, MemoryIndex } from "../../memory/index.js";
import { pruneEmbeddingCache } from "../../memory/index-embedding.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("server.background-jobs.memory-hygiene");

/** Sessions older than this are archived (moved, never deleted). */
export const SESSION_ARCHIVE_MAX_AGE_DAYS = 90;

export interface MemoryHygieneDeps {
  dataDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
}

export function makeRunMemoryHygiene(deps: MemoryHygieneDeps): () => Promise<void> {
  const { sessionStore, memoryIndex } = deps;
  return async () => {
    try {
      const db = memoryIndex.maintenanceDb();
      pruneEmbeddingCache(db, memoryIndex.getConfig());
      // optimize BEFORE the checkpoint: its ANALYZE writes land in the WAL,
      // so running it after would undo the truncation we just did.
      db.pragma("optimize");
      db.pragma("busy_timeout = 100");
      let cp: { busy: number; log: number; checkpointed: number };
      try {
        cp = memoryIndex.checkpoint();
      } finally {
        db.pragma("busy_timeout = 5000");
      }
      logger.info(`[memory-hygiene] db pass: wal busy=${cp.busy} log=${cp.log} checkpointed=${cp.checkpointed}`);
    } catch (e) {
      logger.warn(`[memory-hygiene] db pass failed: ${(e as Error).message}`);
    }
    try {
      const r = sessionStore.archiveOldSessions(SESSION_ARCHIVE_MAX_AGE_DAYS);
      if (r.archived > 0 || r.failed > 0) {
        logger.info(`[memory-hygiene] sessions: archived=${r.archived} skipped=${r.skipped} failed=${r.failed} (>${SESSION_ARCHIVE_MAX_AGE_DAYS}d → sessions-archive/)`);
      }
    } catch (e) {
      logger.warn(`[memory-hygiene] session archival failed: ${(e as Error).message}`);
    }
  };
}
