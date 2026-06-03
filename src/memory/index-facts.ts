import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FactKind, RetainedFact } from "./types.js";
import { parseFactLine, rowToFact, slugify } from "./utils.js";
import { extractRelations } from "./index-relations.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-facts");

export function retain(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  text: string,
  sourceFile: string,
  sourceLine = 0
): RetainedFact[] {
  const facts: RetainedFact[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("- ")) continue;

    const bullet = line.slice(2).trim();
    const parsed = parseFactLine(bullet);
    if (!parsed) continue;

    if (parsed.content.length < 3) continue;

    const validEntities = parsed.entities.filter((e) => e.length > 0);

    const now = Date.now();
    const entitiesJson = JSON.stringify(validEntities.sort());

    try {
      const result = db
        .prepare(
          `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
           source_file, source_line, timestamp, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          parsed.kind,
          parsed.content,
          entitiesJson,
          parsed.confidence,
          "[]",
          "[]",
          sourceFile,
          sourceLine + i + 1,
          now,
          now
        );

      const factId = result.lastInsertRowid as number;

      const fact: RetainedFact = {
        id: factId,
        kind: parsed.kind,
        content: parsed.content,
        entities: validEntities,
        confidence: parsed.confidence,
        evidenceFor: [],
        evidenceAgainst: [],
        sourceFile,
        sourceLine: sourceLine + i + 1,
        timestamp: now,
        lastUpdated: now,
      };

      for (const entity of validEntities) {
        const slug = slugify(entity);
        if (slug) {
          db
            .prepare(
              "INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)"
            )
            .run(factId, slug);
        }
      }

      try { extractRelations(db, parsed.content, validEntities, factId); } catch {}

      let indexError: string | null = null;
      if (hasFts) {
        try {
          db
            .prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)")
            .run(factId, parsed.content);
        } catch (e) {
          indexError = (e as Error).message || "facts_fts insert failed";
          logger.warn(`[memory] facts_fts insert failed for #${factId}: ${indexError}`);
        }
      }
      if (indexError) {
        (fact as RetainedFact & { indexFailed?: boolean; indexError?: string }).indexFailed = true;
        (fact as RetainedFact & { indexFailed?: boolean; indexError?: string }).indexError = indexError;
      }

      facts.push(fact);
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("UNIQUE")) {
        logger.warn(`[memory] Failed to retain fact: ${msg}`);
      }
    }
  }

  return facts;
}

export async function retainSmart(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  text: string,
  sourceFile: string,
  sourceLine = 0,
  opts?: { candidateLimit?: number; resolverOpts?: { provider?: "ollama" | "anthropic" | "openai" | "auto"; model?: string } }
): Promise<{ facts: RetainedFact[]; decisions: Array<{ content: string; op: string; targetId?: number; reason: string }> }> {
  const { resolveFact } = await import("./resolver.js");
  const candidateLimit = opts?.candidateLimit ?? 5;
  const facts: RetainedFact[] = [];
  const decisions: Array<{ content: string; op: string; targetId?: number; reason: string }> = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("- ")) continue;
    const bullet = line.slice(2).trim();
    const parsed = parseFactLine(bullet);
    if (!parsed || parsed.content.length < 3) continue;
    const validEntities = parsed.entities.filter((e) => e.length > 0);

    const candidates = findResolverCandidates(db, hasFts, parsed.content, validEntities, candidateLimit);
    const decision = await resolveFact(parsed.content, candidates, opts?.resolverOpts);
    decisions.push({ content: parsed.content, op: decision.op, targetId: decision.targetId, reason: decision.reason });

    if (decision.op === "NOOP") continue;

    if (decision.op === "DELETE" && decision.targetId !== undefined) {
      invalidateFact(db, decision.targetId, { reason: `deleted by resolver: ${decision.reason}` });
      continue;
    }

    const now = Date.now();
    const entitiesJson = JSON.stringify(validEntities.sort());
    try {
      const result = db.prepare(
        `INSERT INTO facts (kind, content, entities, confidence, evidence_for, evidence_against,
           source_file, source_line, timestamp, last_updated, valid_from)
         VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)`
      ).run(parsed.kind, parsed.content, entitiesJson, parsed.confidence,
            sourceFile, sourceLine + i + 1, now, now, now);
      const factId = result.lastInsertRowid as number;

      if (decision.op === "UPDATE" && decision.targetId !== undefined) {
        invalidateFact(db, decision.targetId, { reason: `superseded by ${factId}: ${decision.reason}`, replacedBy: factId });
      }

      for (const entity of validEntities) {
        const slug = slugify(entity);
        if (slug) db.prepare("INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)").run(factId, slug);
      }
      try { extractRelations(db, parsed.content, validEntities, factId); } catch {}
      if (hasFts) {
        try { db.prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)").run(factId, parsed.content); } catch {}
      }

      facts.push({
        id: factId, kind: parsed.kind, content: parsed.content, entities: validEntities,
        confidence: parsed.confidence, evidenceFor: [], evidenceAgainst: [],
        sourceFile, sourceLine: sourceLine + i + 1, timestamp: now, lastUpdated: now,
        validFrom: now, validTo: null,
      });
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn(`[memory] retainSmart failed on "${parsed.content.slice(0, 60)}": ${msg}`);
    }
  }

  return { facts, decisions };
}

function findResolverCandidates(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  content: string,
  entities: string[],
  limit: number
): Array<{ id: number; content: string; kind: string; timestamp: number }> {
  if (entities.length === 0) {
    if (!hasFts) return [];
    const keywords = content.split(/\s+/).slice(0, 5).join(" OR ");
    try {
      const rows = db.prepare(
        `SELECT f.id, f.content, f.kind, f.timestamp FROM facts f
         JOIN facts_fts fts ON fts.rowid = f.id
         WHERE facts_fts MATCH ? AND f.valid_to IS NULL
         ORDER BY f.timestamp DESC LIMIT ?`
      ).all(keywords, limit) as Array<{ id: number; content: string; kind: string; timestamp: number }>;
      return rows;
    } catch { return []; }
  }
  const slugs = entities.map(e => slugify(e)).filter(Boolean);
  if (slugs.length === 0) return [];
  const placeholders = slugs.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT DISTINCT f.id, f.content, f.kind, f.timestamp FROM facts f
     JOIN entity_mentions em ON em.fact_id = f.id
     WHERE em.entity_slug IN (${placeholders}) AND f.valid_to IS NULL
     ORDER BY f.timestamp DESC LIMIT ?`
  ).all(...slugs, limit) as Array<{ id: number; content: string; kind: string; timestamp: number }>;
  return rows;
}

export function recallByEntity(
  db: InstanceType<typeof Database>,
  entitySlug: string,
  limit = 20,
  opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
  const slug = slugify(entitySlug);
  const validFilter = opts?.includeInvalidated ? "" : "AND f.valid_to IS NULL";
  const rows = db
    .prepare(
      `SELECT f.* FROM facts f
       JOIN entity_mentions em ON em.fact_id = f.id
       WHERE em.entity_slug = ? ${validFilter}
       ORDER BY f.timestamp DESC
       LIMIT ?`
    )
    .all(slug, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToFact);
}

export function recallByKind(
  db: InstanceType<typeof Database>,
  kind: FactKind,
  limit = 20,
  opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
  const validFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
  const rows = db
    .prepare(`SELECT * FROM facts WHERE kind = ? ${validFilter} ORDER BY timestamp DESC LIMIT ?`)
    .all(kind, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

// Every currently-valid fact across all kinds, newest first. Unlike
// recallRecentFacts (kind-filtered, confidence-gated, entity-deduped for prompt
// injection), this is the unfiltered candidate pool for importance ranking —
// stable high-confidence facts must not be excluded before they can be scored.
export function allValidFacts(
  db: InstanceType<typeof Database>,
  limit = 1000,
): RetainedFact[] {
  const rows = db
    .prepare(`SELECT * FROM facts WHERE valid_to IS NULL ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

export function recallByTime(
  db: InstanceType<typeof Database>,
  since: Date,
  until?: Date,
  limit = 50,
  opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
  const sinceMs = since.getTime();
  const untilMs = until ? until.getTime() : Date.now();
  const validFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE timestamp >= ? AND timestamp <= ? ${validFilter}
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(sinceMs, untilMs, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

export function recallOpinions(
  db: InstanceType<typeof Database>,
  entitySlug?: string,
  opts?: { includeInvalidated?: boolean }
): RetainedFact[] {
  const validFilter = opts?.includeInvalidated ? "" : "AND f.valid_to IS NULL";
  if (entitySlug) {
    const slug = slugify(entitySlug);
    const rows = db
      .prepare(
        `SELECT f.* FROM facts f
         JOIN entity_mentions em ON em.fact_id = f.id
         WHERE f.kind = 'opinion' AND em.entity_slug = ? ${validFilter}
         ORDER BY f.confidence DESC, f.last_updated DESC`
      )
      .all(slug) as Array<Record<string, unknown>>;
    return rows.map(rowToFact);
  }

  const bareValidFilter = opts?.includeInvalidated ? "" : "AND valid_to IS NULL";
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE kind = 'opinion' ${bareValidFilter} ORDER BY confidence DESC, last_updated DESC`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

export function recallAsOf(
  db: InstanceType<typeof Database>,
  asOf: Date,
  opts?: { kind?: FactKind; entitySlug?: string; limit?: number }
): RetainedFact[] {
  const t = asOf.getTime();
  const limit = opts?.limit ?? 50;
  const conditions: string[] = [
    "(f.valid_from IS NULL OR f.valid_from <= ?)",
    "(f.valid_to IS NULL OR f.valid_to > ?)",
  ];
  const params: unknown[] = [t, t];
  let join = "";
  if (opts?.kind) { conditions.push("f.kind = ?"); params.push(opts.kind); }
  if (opts?.entitySlug) {
    join = "JOIN entity_mentions em ON em.fact_id = f.id";
    conditions.push("em.entity_slug = ?");
    params.push(slugify(opts.entitySlug));
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT f.* FROM facts f ${join}
       WHERE ${conditions.join(" AND ")}
       ORDER BY f.timestamp DESC LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToFact);
}

export function invalidateFact(
  db: InstanceType<typeof Database>,
  id: number,
  opts?: { reason?: string; replacedBy?: number; at?: Date }
): boolean {
  const at = (opts?.at || new Date()).getTime();
  const r = db
    .prepare(
      `UPDATE facts
       SET valid_to = ?, invalidated_by = ?, invalidation_reason = ?, last_updated = ?
       WHERE id = ? AND valid_to IS NULL`
    )
    .run(at, opts?.replacedBy ?? null, opts?.reason ?? null, at, id);
  return r.changes > 0;
}

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
export function purgeInvalidatedFacts(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  olderThanMs: number
): number {
  const cutoff = Date.now() - olderThanMs;
  const run = db.transaction(() => {
    const rows = db
      .prepare("SELECT id, content FROM facts WHERE valid_to IS NOT NULL AND valid_to < ?")
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
