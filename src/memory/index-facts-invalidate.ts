import type Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { isUserReported } from "./fact-provenance-label.js";
import { tokenizeStrict } from "./text-utils.js";
import { namesSameSubject } from "./same-subject.js";

const logger = createLogger("memory.index-facts");

/** Who is ending a fact's validity. "agent": an in-turn action on the user's
 *  words — update_fact, forget, or remember's contradiction pass. "resolver":
 *  a model's off-turn judgement in retainSmart (background extraction). */
export type InvalidationActor = "agent" | "resolver";

/** The statement a resolver judged to replace an existing fact: its origin,
 *  when it was said (its event date when known, else when it was saved), and
 *  what it says, with the names the user goes by (same-subject.ts). */
export interface ReplacingStatement {
  provenance: string | null;
  sourceFile: string;
  occurredAt: number | null;
  savedAt: number;
  content: string;
  entities: string[];
  userNames: string[];
}

/**
 * Whether a resolver (a model's off-turn judgement) may end fact `id` in
 * favour of `replacing`. Two rules, both on code facts, never on the model's
 * verdict:
 *
 * - Never backwards: a statement older than the fact cannot replace it, so a
 *   late-extracted May note can never end an October one.
 * - Authority: what a model wrote on its own account (origin "assistant", not
 *   isUserReported) may be replaced by anything newer; what the user said —
 *   quoted, in the agent's words, or with no recorded origin — only by a newer
 *   statement that is itself the user's. Live 2026-10-09: background
 *   extraction saved "is the user's cousin", a 3B resolver judged it an UPDATE
 *   of the user's Merriweather story and ended it, and the agent called the
 *   story made up. That replacement was a model inference ending the user's
 *   words; a newer statement of the user's (a new vial replacing an old one,
 *   2026-11-04) is the user correcting themselves. An ended fact stays on its
 *   entity page as history, so a wrong call is visible, not lost.
 * - Same subject: the statement names everything the fact is filed under
 *   (same-subject.ts). Live 2026-11-05: a "semaglutide" restatement ended the
 *   user's reta dose record.
 */
export function resolverMayEnd(db: InstanceType<typeof Database>, id: number, replacing: ReplacingStatement): boolean {
  const row = db.prepare("SELECT provenance, source_file, occurred_at, timestamp, entities FROM facts WHERE id = ?")
    .get(id) as { provenance: string | null; source_file: string; occurred_at: number | null; timestamp: number; entities: string | null } | undefined;
  if (!row) return true;
  if ((row.occurred_at ?? row.timestamp) > (replacing.occurredAt ?? replacing.savedAt)) return false;
  if (!namesSameSubject({ entities: JSON.parse(row.entities || "[]") as string[] }, replacing, replacing.userNames)) return false;
  const modelsOwn = row.provenance === "assistant" && !isUserReported({ provenance: row.provenance, sourceFile: row.source_file });
  return modelsOwn || isUserReported({ provenance: replacing.provenance, sourceFile: replacing.sourceFile });
}

export function invalidateFact(
  db: InstanceType<typeof Database>,
  id: number,
  opts: { by: InvalidationActor; reason?: string; replacedBy?: number; at?: Date; replacing?: ReplacingStatement }
): boolean {
  if (opts.by === "resolver" && (!opts.replacing || !resolverMayEnd(db, id, opts.replacing))) {
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

/** Words that carry the claim however short — tokenizeStrict drops both:
 *  a number ("slip 31" is not "slip 14") and a negation ("does not own" is
 *  not "owns"). */
const NUMBER = /^\d+$/;
const NEGATION = new Set(["not", "no", "never"]);

function claimWords(text: string): { words: Set<string>; numbers: Set<string>; negations: Set<string> } {
  const words = tokenizeStrict(text);
  // The extractor names the speaker "the user"; the agent uses their name.
  words.delete("user");
  const raw = text.toLowerCase().split(/[^a-z0-9]+/);
  return {
    words,
    numbers: new Set(raw.filter((w) => NUMBER.test(w))),
    negations: new Set(raw.filter((w) => NEGATION.has(w))),
  };
}

/** A current fact already says this: every number in the new statement is in
 *  it, it is negated exactly where the new one is, and at least 80% of the new
 *  statement's other words are in it. Directional on purpose — a short fact
 *  the new one merely mentions ("Odalys is the user's cousin") does not say a
 *  sailboat. */
export function alreadySaid(content: string, candidates: Array<{ content: string }>): boolean {
  const said = claimWords(content);
  return candidates.some((c) => {
    const known = claimWords(c.content);
    for (const n of said.numbers) if (!known.numbers.has(n)) return false;
    if (said.negations.size !== known.negations.size) return false;
    for (const w of said.negations) if (!known.negations.has(w)) return false;
    if (said.words.size === 0) return true;
    let shared = 0;
    for (const w of said.words) if (known.words.has(w)) shared++;
    return shared / said.words.size >= 0.8;
  });
}

/** What the agent saved from user message `messageId` (remember / update_fact
 *  record it, resolve-tool.ts) already says this — read together, because the
 *  agent splits one message into several facts. Background extraction of the
 *  same message then has nothing to add: its restatement was a second copy
 *  that a later correction ended only half of (2026-10-18: "User's cousin
 *  Odalys keeps her sailboat … slip 14" beside the agent's "Odalys owns a
 *  sailboat named Kestrel Nine, docked at slip 14 in Port Avila"). */
export function savedFromMessage(db: InstanceType<typeof Database>, content: string, messageId: string): boolean {
  const rows = db.prepare("SELECT content FROM facts WHERE source_message_id = ? AND valid_to IS NULL")
    .all(messageId) as Array<{ content: string }>;
  return rows.length > 0 && alreadySaid(content, [{ content: rows.map((r) => r.content).join("\n") }]);
}
