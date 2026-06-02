import type Database from "better-sqlite3";
import { slugify } from "./utils.js";
import { extractRelationTriples } from "./relation-patterns.js";

export function storeRelation(
  db: InstanceType<typeof Database>,
  opts: {
    subject: string;
    predicate: string;
    object: string;
    factId?: number;
    chunkId?: number;
    confidence?: number;
  }
): void {
  const subject = slugify(opts.subject);
  const object = slugify(opts.object);
  const predicate = opts.predicate.toLowerCase().trim();
  if (!subject || !predicate || !object) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO entity_relations
         (subject, predicate, object, fact_id, chunk_id, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(subject, predicate, object, opts.factId ?? null, opts.chunkId ?? null, opts.confidence ?? 1.0, Date.now());
  } catch {}
}

export function getRelationsFor(
  db: InstanceType<typeof Database>,
  entity: string,
  limit = 30
): Array<{ subject: string; predicate: string; object: string; factId: number | null; chunkId: number | null }> {
  const slug = slugify(entity);
  const rows = db.prepare(
    `SELECT subject, predicate, object, fact_id, chunk_id FROM entity_relations
     WHERE subject = ? OR object = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(slug, slug, limit) as Array<{ subject: string; predicate: string; object: string; fact_id: number | null; chunk_id: number | null }>;
  return rows.map(r => ({ subject: r.subject, predicate: r.predicate, object: r.object, factId: r.fact_id, chunkId: r.chunk_id }));
}

export function traverseFrom(
  db: InstanceType<typeof Database>,
  entity: string,
  maxHops = 2
): Set<string> {
  const visited = new Set<string>();
  const frontier: Array<{ slug: string; depth: number }> = [{ slug: slugify(entity), depth: 0 }];
  visited.add(slugify(entity));
  while (frontier.length > 0) {
    const { slug, depth } = frontier.shift()!;
    if (depth >= maxHops) continue;
    const neighbors = db.prepare(
      `SELECT DISTINCT CASE WHEN subject = ? THEN object ELSE subject END as neighbor
       FROM entity_relations WHERE subject = ? OR object = ?`
    ).all(slug, slug, slug) as Array<{ neighbor: string }>;
    for (const { neighbor } of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        frontier.push({ slug: neighbor, depth: depth + 1 });
      }
    }
  }
  return visited;
}

/**
 * Promote explicit `[[name]]` wikilinks into typed, traversable edges. The
 * fact's primary entity and every linked target form a `links-to` clique at
 * full confidence — these are author-asserted, not inferred. Runs even when no
 * @-entities were tagged, since a link is its own assertion.
 */
function extractWikilinks(
  db: InstanceType<typeof Database>,
  text: string,
  entities: string[],
  factId?: number,
  chunkId?: number
): number {
  const targets = [...text.matchAll(/\[\[([^[\]]+)\]\]/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (targets.length === 0) return 0;

  const nodes = entities[0] ? [entities[0], ...targets] : targets;
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (slugify(nodes[i]) === slugify(nodes[j])) continue;
      storeRelation(db, { subject: nodes[i], predicate: "links-to", object: nodes[j], factId, chunkId, confidence: 1.0 });
      count++;
    }
  }
  return count;
}

export function extractRelations(
  db: InstanceType<typeof Database>,
  text: string,
  entities: string[],
  factId?: number,
  chunkId?: number
): number {
  if (!text) return 0;
  let count = extractWikilinks(db, text, entities, factId, chunkId);
  if (entities.length === 0) return count;
  for (const t of extractRelationTriples(text, entities)) {
    storeRelation(db, { ...t, factId, chunkId });
    count++;
  }
  return count;
}

export function relationCount(db: InstanceType<typeof Database>): number {
  return (db.prepare("SELECT COUNT(*) as n FROM entity_relations").get() as { n: number }).n;
}
