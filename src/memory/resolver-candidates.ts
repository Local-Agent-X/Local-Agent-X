/**
 * Which current facts a statement might replace: the candidates the resolver
 * (resolver.ts) compares it against, at write time (retainSmart) and in the
 * background sweep over stored facts (supersede-sweep.ts).
 */
import type Database from "better-sqlite3";
import { slugify } from "./utils.js";
import { tokenizeStrict } from "./text-utils.js";

export interface ResolverCandidateRow { id: number; content: string; kind: string; timestamp: number }

/** Content words the FTS match uses; more than this dilutes the ranking. */
const MAX_MATCH_WORDS = 12;

/**
 * The facts most like `content` by its own words (FTS, best match first),
 * then the newest facts sharing one of its entities, up to `limit` each,
 * without repeats. Entities alone were the whole search: a fact tagged with
 * the user ("peter") was compared with the user's five newest facts on any
 * subject, so a new retatrutide vial was never set beside the old one
 * (2026-11-04).
 *
 * `olderThan` keeps only facts saved at or before that time (the sweep asks
 * what an existing fact replaces, never what replaces it); `excludeId` drops
 * the statement itself.
 */
export function findResolverCandidates(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  content: string,
  entities: string[],
  limit: number,
  opts: { olderThan?: number; excludeId?: number } = {},
): ResolverCandidateRow[] {
  const byId = new Map<number, ResolverCandidateRow>();
  const add = (rows: ResolverCandidateRow[]) => {
    for (const r of rows) if (r.id !== opts.excludeId && !byId.has(r.id)) byId.set(r.id, r);
  };
  const older = opts.olderThan !== undefined ? "AND f.timestamp <= ?" : "";
  const olderArgs = opts.olderThan !== undefined ? [opts.olderThan] : [];

  const words = [...tokenizeStrict(content)].slice(0, MAX_MATCH_WORDS);
  if (hasFts && words.length > 0) {
    try {
      add(db.prepare(
        `SELECT f.id, f.content, f.kind, f.timestamp FROM facts f
         JOIN facts_fts ON facts_fts.rowid = f.id
         WHERE facts_fts MATCH ? AND f.valid_to IS NULL ${older}
         ORDER BY bm25(facts_fts) LIMIT ?`,
      ).all(words.map((w) => `"${w}"`).join(" OR "), ...olderArgs, limit + 1) as ResolverCandidateRow[]);
    } catch { /* FTS unavailable or the query rejected: the entity pass still runs */ }
  }

  const slugs = entities.map((e) => slugify(e)).filter(Boolean);
  if (slugs.length > 0) {
    add(db.prepare(
      `SELECT DISTINCT f.id, f.content, f.kind, f.timestamp FROM facts f
       JOIN entity_mentions em ON em.fact_id = f.id
       WHERE em.entity_slug IN (${slugs.map(() => "?").join(",")}) AND f.valid_to IS NULL ${older}
       ORDER BY f.timestamp DESC LIMIT ?`,
    ).all(...slugs, ...olderArgs, limit + 1) as ResolverCandidateRow[]);
  }
  return [...byId.values()].slice(0, limit * 2);
}
