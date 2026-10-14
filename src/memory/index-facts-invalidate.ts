import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { isUserReported } from "./fact-provenance-label.js";
import { tokenizeStrict } from "./text-utils.js";

const logger = createLogger("memory.index-facts");

/** Who is ending a fact's validity. "agent": an in-turn action on the user's
 *  words — update_fact, forget, or remember's contradiction pass. "resolver":
 *  a model's off-turn judgement in retainSmart (background extraction). */
export type InvalidationActor = "agent" | "resolver";

/**
 * A resolver may only revise what a model wrote on its own account: origin
 * "assistant" and not reported as the user's (isUserReported). What the user
 * said — quoted or in the agent's words — and rows with no recorded origin end
 * only by an agent action. Live 2026-10-09: 20 s after a chat, background
 * extraction saved "is the user's cousin", and a 3B resolver judged it an
 * UPDATE of the user's Merriweather story (both tagged Odalys) and ended it;
 * on the next chat the agent had no fact and called it made up.
 */
export function resolverMayEnd(db: InstanceType<typeof Database>, id: number): boolean {
  const row = db.prepare("SELECT provenance, source_file FROM facts WHERE id = ?").get(id) as { provenance: string | null; source_file: string } | undefined;
  return !row || (row.provenance === "assistant" && !isUserReported({ provenance: row.provenance, sourceFile: row.source_file }));
}

export function invalidateFact(
  db: InstanceType<typeof Database>,
  id: number,
  opts: { by: InvalidationActor; reason?: string; replacedBy?: number; at?: Date }
): boolean {
  if (opts.by === "resolver" && !resolverMayEnd(db, id)) {
    logger.info(`[memory] resolver may not end fact #${id}: ${opts.reason ?? ""}`);
    return false;
  }
  const at = (opts.at || new Date()).getTime();
  const r = db
    .prepare(
      `UPDATE facts
       SET valid_to = ?, invalidated_by = ?, invalidation_reason = ?, last_updated = ?
       WHERE id = ? AND valid_to IS NULL`
    )
    .run(at, opts.replacedBy ?? null, opts.reason ?? null, at, id);
  return r.changes > 0;
}

/** A current fact already says this: at least 80% of the new statement's words
 *  are in one of them. Directional on purpose — a short fact the new one
 *  merely mentions ("Odalys is the user's cousin") does not say a sailboat. */
export function alreadySaid(content: string, candidates: Array<{ content: string }>): boolean {
  const words = tokenizeStrict(content);
  if (words.size === 0) return true;
  return candidates.some((c) => {
    const known = tokenizeStrict(c.content);
    let shared = 0;
    for (const w of words) if (known.has(w)) shared++;
    return shared / words.size >= 0.8;
  });
}
