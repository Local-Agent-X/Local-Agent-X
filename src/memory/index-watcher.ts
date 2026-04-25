import { watch } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./types.js";

export interface WatcherHandle {
  watcher: ReturnType<typeof watch> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export function startWatcher(
  memoryDir: string,
  setDirty: () => void,
  handle: WatcherHandle
): void {
  try {
    handle.watcher = watch(memoryDir, { recursive: true }, (_event, filename) => {
      if (
        filename &&
        (filename.includes(".git") ||
          filename.includes("node_modules") ||
          filename.startsWith("."))
      ) {
        return;
      }

      if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
      handle.debounceTimer = setTimeout(() => {
        setDirty();
        handle.debounceTimer = null;
      }, 500);
    });
  } catch {
  }
}

export function archiveOldFacts(
  db: InstanceType<typeof Database>,
  config: MemoryConfig,
  hasFts: boolean
): void {
  const cutoffMs =
    Date.now() - config.factRetentionDays * 24 * 60 * 60 * 1000;
  const threshold = config.lowConfidenceThreshold;

  const deleted = db.transaction(() => {
    const toDelete = db
      .prepare(
        `SELECT id FROM facts
         WHERE timestamp < ? OR (kind = 'opinion' AND confidence < ?)`
      )
      .all(cutoffMs, threshold) as Array<{ id: number }>;

    if (toDelete.length === 0) return 0;

    for (const { id } of toDelete) {
      const fact = db.prepare("SELECT content FROM facts WHERE id = ?").get(id) as { content: string } | undefined;
      if (fact) {
        const hash = createHash("sha256").update(fact.content).digest("hex");
        try { db.prepare("DELETE FROM embedding_cache WHERE hash = ?").run(hash); } catch {}
      }
      db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(id);
      if (hasFts) {
        try {
          db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(id);
        } catch {}
      }
    }

    db
      .prepare(
        `DELETE FROM facts
         WHERE timestamp < ? OR (kind = 'opinion' AND confidence < ?)`
      )
      .run(cutoffMs, threshold);

    return toDelete.length;
  })();

  if (deleted > 0) {
    console.log(`[memory] Archived ${deleted} old/low-confidence facts`);
  }
}
