/**
 * Memory schema steps v15–v21 (split from index-schema-migrations.ts):
 * the retrieval and provenance repairs of October 2026, and the change log
 * of November. Runs inside migrateSchema's transaction, after the earlier
 * steps.
 */
import type Database from "better-sqlite3";
import { installFactEvents, logPastEnds } from "./fact-events.js";
import { uniqueEvidenceJson } from "./index-reflect.js";

export function migrateRetrievalAndProvenance(db: InstanceType<typeof Database>, fromVersion: number): void {
  if (fromVersion < 15) {
    // v15: session chunks carry per-message provenance (chunking.ts
    // buildSessionChunks — message ids, the exchange's own time). Existing
    // session chunks were dated by the session's start. Blank the stored
    // hash of every session file so the next sync re-indexes each one once
    // through the builder. The old session-live/ copies are left to the
    // sync sweep, which no longer exempts them and removes them with their
    // FTS and vector rows.
    try { db.exec(`UPDATE files SET hash = '' WHERE source = 'session' AND path NOT LIKE 'session-live/%'`); } catch {}
  }

  if (fromVersion < 16) {
    // v16: the keyword indexes stem (index-schema.ts FTS_TOKENIZE). Without
    // it every-word search failed on word endings — "text" never matched
    // "texted" — and a weaker chunk that happened to carry the literal word
    // won instead: an eval run's past-session search returned the agent's own
    // answer and missed the message the user had said it in, and the agent
    // took a true fact back (2026-10-08). A tokenizer is fixed when an FTS
    // table is created, so drop both here; initSchema recreates them and
    // rebuilds their rows from chunks/facts.
    try { db.exec("DROP TABLE IF EXISTS chunks_fts"); } catch {}
    try { db.exec("DROP TABLE IF EXISTS facts_fts"); } catch {}
  }

  if (fromVersion < 18) {
    // v17/v18: re-chunk every session once through the current indexer.
    // v17 — parsing dropped the harness tag (chunking.ts parseJsonlSession),
    // so kept nudges (since 2026-09-15) and carried-recall rows (since
    // 2026-10-13) were indexed as "[user] …". v18 — the idempotent indexer
    // now keeps one row per distinct chunk (index-ingest.ts); duplicates
    // older indexers wrote survived every re-index before it, v17's
    // included (298 groups on one install). Its delete path also removes
    // their FTS and vector rows. A v16 install re-chunks once.
    try { db.exec(`UPDATE files SET hash = '' WHERE source = 'session'`); } catch {}
  }

  if (fromVersion < 19) {
    // v19: the user message a fact was saved while answering (remember /
    // update_fact), so "you told me that" can point at the message itself —
    // search_past_sessions(message_id) reads it. NULL for older rows and for
    // facts no user message produced (extraction, daily logs, dream).
    try { db.exec(`ALTER TABLE facts ADD COLUMN source_message_id TEXT`); } catch {}
  }

  if (fromVersion < 20) {
    // v20: a project document's whole extracted text, so a project small
    // enough to fit the model's window gets its documents in full
    // (project-docs/full-text.ts). The chunks overlap and cannot be joined
    // back. Blank the stamp of every indexed document so the next pass
    // re-extracts each one once and fills the table.
    db.exec(`CREATE TABLE IF NOT EXISTS project_doc_text (path TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL)`);
    try { db.exec(`UPDATE files SET hash = '' WHERE source = 'project-doc'`); } catch {}
  }

  if (fromVersion < 21) {
    // v21: the memory change log (fact-events.ts): every create, change, end
    // and delete of a fact, with the row before and after, for history and
    // undo. initSchema re-creates its triggers on every open as well, so a
    // facts column a later step adds is captured. Ends made before the log
    // existed are logged too, so they can be undone.
    installFactEvents(db);
    logPastEnds(db);
  }

  if (fromVersion < 22) {
    // v22: each fact's evidence list once per source. Reflection re-added the
    // same sources on every run (index-reflect.ts, fixed with this step), so
    // one fact held 10,646 entries of which 23 were distinct, and the list
    // was 89% of the 40 MB facts sync file. Only repeats go; every distinct
    // source stays, in the order first seen. evidence_for is upkeep to the
    // change log (fact-events.ts), so this writes no events.
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'facts'`).get()) {
      const rows = db.prepare(`SELECT id, evidence_for FROM facts WHERE evidence_for LIKE '%,%'`).all() as Array<{ id: number; evidence_for: string }>;
      const update = db.prepare(`UPDATE facts SET evidence_for = ? WHERE id = ?`);
      for (const row of rows) {
        const unique = uniqueEvidenceJson(row.evidence_for);
        if (unique !== row.evidence_for) update.run(unique, row.id);
      }
    }
  }
}
