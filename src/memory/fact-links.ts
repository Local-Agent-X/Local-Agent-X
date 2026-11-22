/**
 * The rows that make a fact findable: its entity mentions (name recall, topic
 * pages), its relation edges (graph traversal) and its full-text row (search).
 * No trigger writes them, so every path that puts a row into `facts` calls
 * this: a learned fact (index-facts.ts), one arriving from another machine
 * (sync/facts-sync.ts), one brought back or reverted by undo (fact-undo.ts).
 *
 * Each of those paths wrote the rows in its own code. Sync and undo wrote no
 * relation edges, so a fact learned on another machine was missing from every
 * graph traversal here, and sync once wrote no search row either.
 */
import type Database from "better-sqlite3";
import { extractRelations } from "./index-relations.js";
import { slugify } from "./utils.js";
import { createLogger } from "../logger.js";

const logger = createLogger("memory.fact-links");

type Db = InstanceType<typeof Database>;

export interface FactLinkResult {
  /** Why the search row could not be written, or null. The fact itself is
   *  saved either way; without the row no keyword search finds it. */
  indexError: string | null;
}

/** Write a new fact row's mentions, relation edges and search row. */
export function linkFact(db: Db, hasFts: boolean, factId: number, content: string, entities: readonly string[]): FactLinkResult {
  const mention = db.prepare("INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)");
  for (const entity of entities) {
    const slug = slugify(entity);
    if (slug) mention.run(factId, slug);
  }

  // Edges are a derived convenience: a pattern that throws on odd text must
  // not cost the user the fact.
  try { extractRelations(db, content, [...entities], factId); }
  catch (e) { logger.warn(`[memory] relation extraction failed for #${factId}: ${(e as Error).message}`); }

  if (!hasFts) return { indexError: null };
  try {
    db.prepare("INSERT INTO facts_fts (rowid, content) VALUES (?, ?)").run(factId, content);
    return { indexError: null };
  } catch (e) {
    const indexError = (e as Error).message || "facts_fts insert failed";
    logger.warn(`[memory] facts_fts insert failed for #${factId}: ${indexError}`);
    return { indexError };
  }
}

/**
 * Drop a fact's links and write them again from `content` and `entities`: for
 * a row that came back, or whose text or entities went back to an earlier
 * value, so nothing from the wording it no longer has still points at it.
 */
export function relinkFact(db: Db, hasFts: boolean, factId: number, content: string, entities: readonly string[]): FactLinkResult {
  db.prepare("DELETE FROM entity_mentions WHERE fact_id = ?").run(factId);
  db.prepare("DELETE FROM entity_relations WHERE fact_id = ?").run(factId);
  if (hasFts) {
    try { db.prepare("DELETE FROM facts_fts WHERE rowid = ?").run(factId); } catch { /* not indexed */ }
  }
  return linkFact(db, hasFts, factId, content, entities);
}
