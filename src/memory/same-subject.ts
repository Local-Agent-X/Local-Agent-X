/**
 * Whether a newer statement is about what an older fact is about — the
 * condition for a resolver (a model's off-turn judgement) to end the older
 * fact in its favour (index-facts-invalidate.ts resolverMayEnd).
 *
 * 2026-11-05: background extraction restated the user's reta vial as
 * "User's semaglutide protocol now uses a 50mg vial mixed with 2mL ...". The
 * supersede sweep's model saw the same vial, water and syringe, judged it an
 * update of the user's reta dose record, and ended that record: the newer
 * statement never named reta, and nothing in code checked. A wrong verdict
 * here loses a fact quietly; a refused one leaves two current facts the agent
 * can see side by side. So the rule refuses unless every entity the older
 * fact is filed under is named by the newer one.
 */
import { slugCandidates } from "./entity-context.js";
import { slugify } from "./utils.js";

/** Shortest word that may stand for a longer name by prefix ("reta" for "retatrutide"). */
const MIN_PREFIX = 4;

export interface SubjectStatement {
  content: string;
  entities: string[];
}

/**
 * Every entity of `older` is named by `newer`: among its entities, as words of
 * its text (any spacing or hyphenation), or as a word one is a prefix of
 * ("reta" / "retatrutide"). The user's own name counts as named by any
 * statement, since facts call them by name or "the user" interchangeably.
 */
export function namesSameSubject(older: { entities: string[] }, newer: SubjectStatement, userNames: string[]): boolean {
  const self = new Set(userNames.map(slugify).filter(Boolean));
  const tagged = new Set(newer.entities.map(slugify));
  const spans = new Set(slugCandidates(newer.content));
  const words = newer.content.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_PREFIX);
  return older.entities.map(slugify).filter(Boolean).every((e) =>
    self.has(e) || tagged.has(e) || spans.has(e)
    || (e.length >= MIN_PREFIX && !e.includes("-") && words.some((w) => w.startsWith(e) || e.startsWith(w))));
}
