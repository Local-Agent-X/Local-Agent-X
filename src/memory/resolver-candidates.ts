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
/** Best FTS matches ranked before the current/older filter; far more than the few
 *  candidates kept, so ended or newer facts near the top cannot crowd them out. */
const RANKED_POOL = 200;

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
      // Ranked inside the FTS index first, then filtered: joining every match to
      // `facts` before ranking took 0.5–1.1 s for a dozen OR'd words matching 1–5k
      // facts, all of it on the server's one thread, and the sweep runs it per fact
      // (voice cut out mid-reply, 2026-11-05). The ranked pool is the same answer.
      add(db.prepare(
        `SELECT f.id, f.content, f.kind, f.timestamp
         FROM (SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?) m
         JOIN facts f ON f.id = m.rowid
         WHERE f.valid_to IS NULL ${older}
         ORDER BY m.rank LIMIT ?`,
      ).all(words.map((w) => `"${w}"`).join(" OR "), RANKED_POOL, ...olderArgs, limit + 1) as ResolverCandidateRow[]);
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
