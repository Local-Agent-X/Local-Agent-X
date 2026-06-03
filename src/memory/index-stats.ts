import type Database from "better-sqlite3";

export function getStats(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  hasVec: boolean
): {
  totalChunks: number;
  totalFiles: number;
  totalFacts: number;
  totalEntities: number;
  hasFts: boolean;
  hasVec: boolean;
  cacheSize: number;
} {
  const chunks = (
    db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }
  ).n;
  const files = (
    db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }
  ).n;
  const facts = (
    db.prepare("SELECT COUNT(*) as n FROM facts").get() as { n: number }
  ).n;
  const entities = (
    db
      .prepare("SELECT COUNT(DISTINCT entity_slug) as n FROM entity_mentions")
      .get() as { n: number }
  ).n;
  const cache = (
    db.prepare("SELECT COUNT(*) as n FROM embedding_cache").get() as {
      n: number;
    }
  ).n;

  return {
    totalChunks: chunks,
    totalFiles: files,
    totalFacts: facts,
    totalEntities: entities,
    hasFts,
    hasVec,
    cacheSize: cache,
  };
}

// The agent's most-known entities, ranked by how often they're mentioned —
// the "known associates" for the identity dossier's network view.
export function topEntities(
  db: InstanceType<typeof Database>,
  limit: number,
): Array<{ slug: string; mentions: number }> {
  return db
    .prepare(
      "SELECT entity_slug AS slug, COUNT(*) AS mentions FROM entity_mentions GROUP BY entity_slug ORDER BY mentions DESC, entity_slug LIMIT ?",
    )
    .all(limit) as Array<{ slug: string; mentions: number }>;
}
