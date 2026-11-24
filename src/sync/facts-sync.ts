import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabaseSafe } from "../memory/index-db.js";
import { linkFact } from "../memory/fact-links.js";
import { installFactEvents, isErased, withFactActor } from "../memory/fact-events.js";
import { uniqueEvidenceJson } from "../memory/index-reflect.js";
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
  provenance: string | null;
  occurred_at: number | null;
  source_message_id: string | null;
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
  // Where the fact came from: whose words, when it happened, the message it
  // was saved from. Without them an imported fact had no origin, so a
  // model's own note read as something the user said (memory audit
  // 2026-11-08, finding 5). Absent in files written before they were added.
  provenance?: string | null;
  occurred_at?: number | null;
  source_message_id?: string | null;
  // `invalidated_by` is encoded as the natural identity of the
  // replacement fact, not a local row ID — IDs differ per machine. The
  // import resolves this to a local row ID in a second pass.
  invalidated_by_key: { kind: string; content: string; entities: string } | null;
}

/** The entity names in a synced row's `entities` JSON; none when malformed. */
function entityNames(entitiesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(entitiesJson);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string" && e.length > 0) : [];
  } catch {
    return [];
  }
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
        provenance: f.provenance,
        occurred_at: f.occurred_at,
        source_message_id: f.source_message_id,
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

interface LocalFact { id: number; last_updated: number; valid_to: number | null }

/**
 * This machine's facts by identity (kind, content, entities), read once.
 * Several rows can share one identity (a fact and the copy that replaced it).
 */
function localFactsByIdentity(db: ReturnType<typeof openDatabaseSafe>): Map<string, LocalFact[]> {
  const rows = db.prepare("SELECT id, kind, content, entities, last_updated, valid_to FROM facts ORDER BY id")
    .all() as Array<LocalFact & { kind: string; content: string; entities: string }>;
  const byIdentity = new Map<string, LocalFact[]>();
  for (const row of rows) {
    const key = identityKey(row);
    const fact = { id: row.id, last_updated: row.last_updated, valid_to: row.valid_to };
    const same = byIdentity.get(key);
    if (same) same.push(fact); else byIdentity.set(key, [fact]);
  }
  return byIdentity;
}

/** The row an import merges into: the one still valid, then the most recently
 *  updated. The order the per-fact query used, applied to rows as they stand
 *  now, so an update made earlier in the same import is seen. */
function mergeTarget(rows: LocalFact[] | undefined): LocalFact | undefined {
  let best: LocalFact | undefined;
  for (const row of rows ?? []) {
    if (!best) { best = row; continue; }
    const rowLive = row.valid_to === null;
    const bestLive = best.valid_to === null;
    if (rowLive !== bestLive ? rowLive : row.last_updated > best.last_updated) best = row;
  }
  return best;
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
      // This machine's fact for each identity, read once. A lookup per synced
      // fact scanned the whole table each time (no index covers the three
      // columns), so an import of N facts cost N scans: seconds at every start.
      const local = localFactsByIdentity(db);
      const insertStmt = db.prepare(
        `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
                            source_file, source_line, timestamp, last_updated,
                            valid_from, valid_to, invalidation_reason,
                            provenance, occurred_at, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateStmt = db.prepare(
        `UPDATE facts SET valid_to = ?, invalidation_reason = ?, last_updated = ?
         WHERE id = ? AND last_updated < ?`
      );

      for (const r of remote) {
        const key = identityKey(r);
        const existing = mergeTarget(local.get(key));

        if (!existing) {
          // Erased here at the user's request: another machine's copy is not
          // a reason to bring it back.
          if (isErased(db, r)) { skipped++; continue; }
          try {
            const res = insertStmt.run(
              r.kind, r.content, r.entities, r.confidence,
              // A machine not yet updated still writes repeated sources.
              uniqueEvidenceJson(r.evidence_for), r.evidence_against,
              r.source_file, r.source_line, r.timestamp, r.last_updated,
              r.valid_from, r.valid_to, r.invalidation_reason,
              r.provenance ?? null, r.occurred_at ?? null, r.source_message_id ?? null
            );
            const newId = res.lastInsertRowid as number;
            idForKey.set(key, newId);
            // A later line with the same identity must find this row, as a
            // query would have.
            local.set(key, [...(local.get(key) ?? []), { id: newId, last_updated: r.last_updated, valid_to: r.valid_to ?? null }]);
            // No trigger writes a fact's search row, mentions or relation
            // edges: without them it is invisible to search, name recall and
            // graph traversal on this machine. The same call a locally
            // learned fact gets.
            linkFact(db, true, newId, r.content, entityNames(r.entities));

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
          existing.valid_to = r.valid_to ?? null;
          existing.last_updated = r.last_updated;
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

    installFactEvents(db);
    withFactActor(db, "sync", txn);

    return { inserted, updated, skipped };
  } finally {
    db.close();
  }
}

