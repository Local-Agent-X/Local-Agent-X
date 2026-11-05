import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// GC + validity accounting for the bitemporal facts store. Split out of
// index-facts.ts; re-exported there so consumers keep one import.

export function validityStats(
  db: InstanceType<typeof Database>
): { valid: number; invalidated: number } {
  const valid = (db.prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NULL").get() as { n: number }).n;
  const invalidated = (db.prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NOT NULL").get() as { n: number }).n;
  return { valid, invalidated };
}

// Hard-delete facts that were soft-invalidated (valid_to set) more than
// `olderThanMs` ago. invalidateFact only flips valid_to so the row stays
// queryable via recallAsOf during a grace window; nothing ever removed those
// rows, so they grew forever. This is the GC. Dependent rows are cascaded the
// same way forgetFacts (index-forget.ts) does: FTS mirror, entity_mentions,
// and the content-keyed embedding_cache. entity_relations rows reference
// facts(id) with ON DELETE CASCADE so SQLite reclaims them automatically when
// foreign_keys is on; we delete them explicitly too in case the pragma is off.
//
// A fact a newer one REPLACED (invalidated_by set) is history, not garbage:
// its entity page lists it under "Earlier (replaced)" so "what was my old
// dose?" has an answer (2026-11-04), so it is never purged. Only facts that
// ended with no replacement (forgotten, or judged no longer true) are.
export function purgeInvalidatedFacts(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  olderThanMs: number
): number {
  const cutoff = Date.now() - olderThanMs;
  const run = db.transaction(() => {
    const rows = db
      .prepare("SELECT id, content FROM facts WHERE valid_to IS NOT NULL AND valid_to < ? AND invalidated_by IS NULL")
      .all(cutoff) as Array<{ id: number; content: string }>;
    for (const r of rows) {
      if (hasFts) {
        try { db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(r.id); } catch {}
      }
      db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(r.id);
      db.prepare("DELETE FROM entity_relations WHERE fact_id = ?").run(r.id);
      const hash = createHash("sha256").update(r.content).digest("hex");
      try { db.prepare("DELETE FROM embedding_cache WHERE hash = ?").run(hash); } catch {}
      db.prepare("DELETE FROM facts WHERE id = ?").run(r.id);
    }
    return rows.length;
  });
  return run();
}
