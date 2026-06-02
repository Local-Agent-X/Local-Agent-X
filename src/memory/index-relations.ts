import type Database from "better-sqlite3";
import { slugify } from "./utils.js";

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
  let wikiCount = extractWikilinks(db, text, entities, factId, chunkId);
  if (entities.length === 0) return wikiCount;
  const VERBS = "decided|decides|suggested|suggests|introduced|introduces|recommended|recommends|told|asked|wants|wanted|likes|prefers|preferred|owns|owned|uses|used|built|builds|created|creates|shipped|ships|launched|launches|joined|joins|left|leaves|met|meets|works|worked|manages|managed|reports|reported|scheduled|schedules|planned|plans|bought|buys|sold|sells|sent|sends|received|receives|served|serves|retired|retires|lives|lived|moved|moves|started|starts|stopped|stops|finished|finishes|completed|completes|belongs";
  const predicateRe = new RegExp(`\\b([A-Z][a-zA-Z]+|my|our|the|W)?\\s*(${VERBS})\\s+(?:(?:about|with|from|into|onto|upon|for|the|an|at|in|on|to|me|us|a)\\s+)?([a-zA-Z][a-zA-Z0-9\\s-]{2,40})`, "gi");
  const trailingNoiseRe = /\s+(and|or|but|when|while|after|before|last|next|right|just|then|so|because|since|until|over|during|yesterday|today|tomorrow|ago)\b.*$/i;
  const leadingFillerRe = /^(the|a|an|my|our|their|his|her|its|this|that|these|those)\s+/i;

  let count = 0;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = predicateRe.exec(text)) !== null) {
    const subjectRaw = (match[1] || "").toLowerCase();
    const predicate = match[2].toLowerCase();
    let objectRaw = match[3].trim();
    objectRaw = objectRaw.replace(trailingNoiseRe, "").trim();
    objectRaw = objectRaw.replace(leadingFillerRe, "").trim();
    const object = objectRaw.split(/\s+/).slice(0, 4).join(" ");

    const subjectFillers = new Set([
      "my", "our", "the", "w", "a", "an", "this", "that", "these", "those",
      "with", "about", "from", "into", "onto", "upon", "for", "at", "in", "on", "to",
      "me", "us", "you", "him", "her", "it", "them", "they", "we", "i",
      "after", "before", "when", "while", "then", "and", "or", "but", "so",
    ]);
    let subject = subjectRaw;
    if (!subject || subjectFillers.has(subject)) {
      subject = entities[0] || "";
    }
    if (!subject) continue;

    if (object.length < 3) continue;
    if (/^(the|a|an|me|us|you|him|her|it|them)$/i.test(object)) continue;
    if (slugify(object) === subject) continue;
    if (object.toLowerCase() === predicate) continue;

    const key = `${subject}|${predicate}|${object}`;
    if (seen.has(key)) continue;
    seen.add(key);

    storeRelation(db, { subject, predicate, object, factId, chunkId });
    count++;
  }
  return count + wikiCount;
}

export function relationCount(db: InstanceType<typeof Database>): number {
  return (db.prepare("SELECT COUNT(*) as n FROM entity_relations").get() as { n: number }).n;
}
