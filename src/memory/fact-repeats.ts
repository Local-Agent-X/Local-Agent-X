/**
 * Whether a current fact already says a statement: the one answer for
 * `remember` (which then saves nothing) and the repeat sweep (which ends the
 * later copy, supersede-sweep.ts).
 *
 * `remember` refused only an exact copy, so every rewording became a fact of
 * its own: on 2026-11-13, 2,552 of 4,597 current facts repeated an older one
 * by this test ("Peter has a friend who works at Snowflake …" beside "The user
 * has a friend who works at Snowflake …"). The test is repeatsFact: every
 * number, the same negation, and no word the older fact lacks, since one
 * swapped word is often the claim. A paraphrase in other words gets past it and
 * is the resolver's to judge.
 * A repeat counts only when the fact that stays stands at least as high as
 * the statement (standsAsHigh): the user's word is never dropped for a model's.
 */
import type Database from "better-sqlite3";
import type { RetainedFact } from "./types.js";
import { rowToFact } from "./utils.js";
import { findResolverCandidates } from "./resolver-candidates.js";
import { repeatsFact } from "./index-facts-invalidate.js";
import { standsAsHigh } from "./fact-provenance-label.js";

const CANDIDATES = 5;

export interface Statement {
  content: string;
  entities: string[];
  provenance: string | null;
  sourceFile: string;
}

/** The current fact that already says `statement`, best match first, or
 *  undefined. `olderThan` / `excludeId` as in findResolverCandidates. */
export function findRepeatOf(
  db: InstanceType<typeof Database>,
  hasFts: boolean,
  statement: Statement,
  opts: { olderThan?: number; excludeId?: number } = {},
): RetainedFact | undefined {
  const byId = db.prepare("SELECT * FROM facts WHERE id = ? AND valid_to IS NULL");
  for (const candidate of findResolverCandidates(db, hasFts, statement.content, statement.entities, CANDIDATES, opts)) {
    if (!repeatsFact(statement.content, candidate)) continue;
    const row = byId.get(candidate.id) as Record<string, unknown> | undefined;
    if (!row) continue;
    const fact = rowToFact(row);
    if (standsAsHigh(fact, statement)) return fact;
  }
  return undefined;
}
