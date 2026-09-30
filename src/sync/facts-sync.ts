import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabaseSafe } from "../memory/index-db.js";
import { slugify } from "../memory/utils.js";
import { createLogger } from "../logger.js";

// Sync the `facts` table (and derived entity_mentions) across machines via
// a JSONL file in the sync repo. NOT the whole memory.db — that's 1.5 GB
// of chunks + embedding cache + FTS that's either machine-specific or
// derivable. Facts are the durable knowledge layer; the rest rebuilds.
//
// File format: one JSON object per line, ordered by valid_from. Local
// auto-increment IDs are stripped because they don't translate across
// machines — facts are identified by (kind, content, entities).
//
// Conflict model: on import, INSERT OR IGNORE against the UNIQUE
// (kind, content, entities) WHERE valid_to IS NULL index. If two machines
// independently created the "same" fact, the later one is silently skipped
// — no data loss, one canonical version wins by insert order.

const logger = createLogger("sync.facts");
const FACTS_FILENAME = "facts.jsonl";

interface FactRow {
  id: number;
  kind: string;
  content: string;
  entities: string; // JSON-stringified array
  confidence: number;
  evidence_for: string;
  evidence_against: string;
  source_file: string;
  source_line: number;
  timestamp: number;
  last_updated: number;
  valid_from: number | null;
  valid_to: number | null;
  invalidated_by: number | null;
  invalidation_reason: string | null;
}

interface ExportedFact {
  // Stable identity (kind + content + entities) so cross-machine dedup
  // doesn't depend on auto-increment IDs.
  kind: string;
  content: string;
  entities: string;
  confidence: number;
  evidence_for: string;
  evidence_against: string;
  source_file: string;
  source_line: number;
  timestamp: number;
  last_updated: number;
  valid_from: number | null;
  valid_to: number | null;
  invalidation_reason: string | null;
  // `invalidated_by` is encoded as the natural identity of the
  // replacement fact, not a local row ID — IDs differ per machine. The
  // import resolves this to a local row ID in a second pass.
  invalidated_by_key: { kind: string; content: string; entities: string } | null;
}

function identityKey(f: { kind: string; content: string; entities: string }): string {
  return `${f.kind}\x00${f.content}\x00${f.entities}`;
}

export function exportFactsForSync(dataDir: string, syncDir: string): { exported: number } {
  const dbPath = join(dataDir, "memory.db");
  if (!existsSync(dbPath)) return { exported: 0 };

  const db = openDatabaseSafe(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    const facts = db.prepare("SELECT * FROM facts ORDER BY valid_from ASC NULLS FIRST, timestamp ASC").all() as FactRow[];

    // Build id -> identity map so we can encode invalidated_by as a stable key.
    const byId = new Map<number, FactRow>();
    for (const f of facts) byId.set(f.id, f);

    const lines: string[] = [];
    for (const f of facts) {
      let invalidatedByKey: ExportedFact["invalidated_by_key"] = null;
      if (f.invalidated_by !== null) {
        const target = byId.get(f.invalidated_by);
        if (target) {
          invalidatedByKey = { kind: target.kind, content: target.content, entities: target.entities };
        }
      }
      const exported: ExportedFact = {
        kind: f.kind,
        content: f.content,
        entities: f.entities,
        confidence: f.confidence,
        evidence_for: f.evidence_for,
        evidence_against: f.evidence_against,
        source_file: f.source_file,
        source_line: f.source_line,
        timestamp: f.timestamp,
        last_updated: f.last_updated,
        valid_from: f.valid_from,
        valid_to: f.valid_to,
        invalidation_reason: f.invalidation_reason,
        invalidated_by_key: invalidatedByKey,
      };
      lines.push(JSON.stringify(exported));
    }

    const outPath = join(syncDir, FACTS_FILENAME);
    writeFileSync(outPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
    return { exported: facts.length };
  } finally {
    db.close();
  }
}

export function importFactsFromSync(dataDir: string, syncDir: string): { inserted: number; updated: number; skipped: number } {
  const inPath = join(syncDir, FACTS_FILENAME);
  if (!existsSync(inPath)) return { inserted: 0, updated: 0, skipped: 0 };

  const raw = readFileSync(inPath, "utf-8");
  if (!raw.trim()) return { inserted: 0, updated: 0, skipped: 0 };

  const remote: ExportedFact[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      remote.push(JSON.parse(trimmed));
    } catch (e) {
      logger.warn(`[sync.facts] skipped malformed line: ${(e as Error).message}`);
    }
  }

  if (remote.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const dbPath = join(dataDir, "memory.db");
  const db = openDatabaseSafe(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    // Pass 1: insert or update each fact by (kind, content, entities)
    // identity. Track a key -> local id map for pass 2 (invalidated_by).
    const idForKey = new Map<string, number>();

    const txn = db.transaction(() => {
      const findStmt = db.prepare(
        `SELECT id, last_updated, valid_to, invalidated_by, invalidation_reason
         FROM facts WHERE kind = ? AND content = ? AND entities = ?
         ORDER BY (valid_to IS NULL) DESC, last_updated DESC LIMIT 1`
      );
      const insertStmt = db.prepare(
        `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
                            source_file, source_line, timestamp, last_updated,
                            valid_from, valid_to, invalidation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateStmt = db.prepare(
        `UPDATE facts SET valid_to = ?, invalidation_reason = ?, last_updated = ?
         WHERE id = ? AND last_updated < ?`
      );
      const insertMentionStmt = db.prepare(
        "INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)"
      );

      for (const r of remote) {
        const key = identityKey(r);
        const existing = findStmt.get(r.kind, r.content, r.entities) as
          | { id: number; last_updated: number; valid_to: number | null; invalidation_reason: string | null }
          | undefined;

        if (!existing) {
          try {
            const res = insertStmt.run(
              r.kind, r.content, r.entities, r.confidence,
              r.evidence_for, r.evidence_against,
              r.source_file, r.source_line, r.timestamp, r.last_updated,
              r.valid_from, r.valid_to, r.invalidation_reason
            );
            const newId = res.lastInsertRowid as number;
            idForKey.set(key, newId);
            // facts_fts is external-content with no triggers: a row that is
            // not written here is invisible to every fact search on this
            // machine until a full rebuild. Same statement index-facts.ts
            // runs for a locally learned fact.
            try { db.prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)").run(newId, r.content); }
            catch (e) { logger.warn(`[sync.facts] facts_fts insert failed for #${newId}: ${(e as Error).message}`); }

            try {
              const ents: string[] = JSON.parse(r.entities) || [];
              for (const e of ents) {
                if (typeof e === "string" && e.length > 0) {
                  insertMentionStmt.run(newId, slugify(e));
                }
              }
            } catch { /* malformed entities JSON — skip mentions */ }

            inserted++;
          } catch (e) {
            const msg = (e as Error).message;
            if (msg.includes("UNIQUE")) {
              skipped++;
            } else {
              logger.warn(`[sync.facts] insert failed: ${msg}`);
              skipped++;
            }
          }
          continue;
        }

        idForKey.set(key, existing.id);

        // Existing fact — propagate validity changes only if remote is newer.
        const remoteNewer = r.last_updated > existing.last_updated;
        const validityDiffers = (existing.valid_to ?? null) !== (r.valid_to ?? null);
        if (remoteNewer && validityDiffers) {
          updateStmt.run(r.valid_to, r.invalidation_reason, r.last_updated, existing.id, r.last_updated);
          updated++;
        } else {
          skipped++;
        }
      }

      // Pass 2: resolve invalidated_by references using the freshly-built
      // identity → local-id map.
      const linkStmt = db.prepare("UPDATE facts SET invalidated_by = ? WHERE id = ?");
      for (const r of remote) {
        if (!r.invalidated_by_key) continue;
        const factId = idForKey.get(identityKey(r));
        const replacementId = idForKey.get(identityKey(r.invalidated_by_key));
        if (factId !== undefined && replacementId !== undefined) {
          linkStmt.run(replacementId, factId);
        }
      }
    });

    txn();

    return { inserted, updated, skipped };
  } finally {
    db.close();
  }
}

