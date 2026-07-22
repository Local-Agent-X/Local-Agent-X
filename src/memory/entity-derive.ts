/**
 * Deterministic entity derivation for the fact-write seam.
 *
 * Entity indexing used to depend entirely on the model typing @-prefixed
 * tags in `remember` content. Models almost never comply: verified
 * 2026-07-22 on a real DB, 2061 of 2261 facts (91%) had zero entity links,
 * so name-based recognition (<known_entities>, recallByEntity) was blind
 * to most of what memory knew. This module derives entities from the fact
 * content itself, in code, so recognition never depends on model
 * compliance again:
 *
 *   1. @-tags still win (explicit beats inferred).
 *   2. Known-entity linking — an existing entity slug that appears
 *      CAPITALIZED in the content gets linked (digit-bearing coinages like
 *      sipdirty805 link case-free). Lowercase occurrences never link:
 *      matching common words case-free is how one bad entity snowballs
 *      across the whole corpus.
 *   3. Proper-noun coining — a token becomes a NEW entity only when it is
 *      name-shaped (CamelCase / letter+digit coinage), or is a capitalized
 *      word that (a) is mid-sentence, (b) is not part of a Title Case run
 *      of 3+ capitalized words (headings, not names), (c) never appears
 *      lowercase in the same content (lowercase use = prose word), and
 *      (d) is not a stopword. Precision over recall: a missed name links
 *      later via rule 2 once any fact coins it; a junk entity poisons
 *      every future fact that contains the word.
 *
 * Order is significant: the returned list is subject-first (content
 * order), because recallRecentFacts dedups core_memory on
 * (kind, entities[0]) — an alphabetical first entity would collapse
 * unrelated facts that merely share an alphabetically-early tag.
 */

import type Database from "better-sqlite3";
import { slugify } from "./utils.js";

/** Slugs that are never entities: junk lengths, bare numbers, calendar
 * words, and function/prose words that routinely appear capitalized. */
const SLUG_STOPWORDS = new Set([
  "user", "agent", "the", "this", "that", "these", "those", "and", "for",
  "with", "not", "but", "from", "over", "into", "onto", "you", "your",
  "our", "his", "her", "its", "their", "they", "them", "there", "here",
  "was", "were", "are", "has", "have", "had", "will", "would", "should",
  "could", "can", "may", "might", "must", "all", "any", "each", "some",
  "only", "also", "then", "than", "when", "where", "what", "which",
  "while", "why", "how", "who", "after", "before", "about", "above",
  "below", "under", "between", "through", "during", "new", "key", "main",
  "next", "first", "last", "best", "top", "more", "most", "other", "same",
  "very", "just", "now", "still", "yet", "per", "via", "use", "using",
  "january", "february", "march", "april", "june", "july",
  "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "yesterday",
  // Generic tech/prose nouns. As entities these make everyday words match
  // the per-turn recognition scan ("the app is broken" → inject app facts)
  // and corrupt reinforcement — the same failure class as substring
  // matching. Real subsystems still surface via their proper names.
  "app", "apps", "tool", "tools", "project", "projects", "memory",
  "memories", "system", "systems", "test", "tests", "build", "builds",
  "code", "file", "files", "data", "model", "models", "server", "servers",
  "chat", "api", "web", "site", "page", "pages", "home", "work", "plan",
  "plans", "task", "tasks", "idea", "ideas", "note", "notes", "name",
  "names", "time", "day", "week", "month", "year", "session", "sessions",
  "update", "updates", "version", "issue", "issues", "error", "errors",
  "bug", "bugs", "fix", "setup", "config", "feature", "features",
  "product", "products", "report", "reports", "list", "item", "items",
  "step", "steps", "phase", "status", "research", "consolidation",
]);

export function validateEntitySlug(slug: string): boolean {
  if (slug.length < 3) return false;
  if (/^\d+$/.test(slug)) return false;
  if (SLUG_STOPWORDS.has(slug)) return false;
  return true;
}

/** Strip possessives and compound-modifier tails ("Clover-native" → "Clover";
 * "Coca-Cola" keeps both halves because both are capitalized). */
function normalizeToken(token: string): string {
  let t = token.replace(/['’]s$/, "");
  const dash = t.indexOf("-");
  if (dash > 0) {
    const tail = t.slice(dash + 1);
    if (!/^[A-Z0-9]/.test(tail)) t = t.slice(0, dash);
  }
  return t;
}

/** Name-shaped regardless of position: CamelCase (MerchOS, StockPilot) or
 * letter/digit coinages (sipdirty805). ALL-CAPS acronyms (MVP, GLP) are
 * deliberately excluded — they are overwhelmingly prose, not names. */
function isNameShaped(token: string): boolean {
  if (/^[A-Z][a-z0-9'’-]+[A-Z]/.test(token)) return true; // CamelCase (needs a lowercase body — MVP/GLP stay prose)
  if (/^[A-Za-z][A-Za-z'’-]*\d/.test(token)) return true; // letter+digit coinage
  return false;
}

/** True when the match position starts a sentence (or the string). */
function isSentenceInitial(content: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /[\s"'"'()\[\]]/.test(content[i])) i--;
  if (i < 0) return true;
  return /[.!?:\n]/.test(content[i]);
}

interface Token { raw: string; index: number }

function tokenize(content: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z][A-Za-z0-9'’-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push({ raw: m[0], index: m.index });
  return out;
}

/** Length of the maximal run of space-adjacent capitalized tokens that
 * contains position `i`. "Google App Approval Friction" → 4 for each of
 * its words; punctuation between tokens breaks the run. */
function capitalizedRunLength(content: string, tokens: Token[], i: number): number {
  const cap = (t: Token) => /^[A-Z]/.test(t.raw);
  const adjacent = (a: Token, b: Token) =>
    /^\s+$/.test(content.slice(a.index + a.raw.length, b.index));
  if (!cap(tokens[i])) return 0;
  let len = 1;
  for (let j = i - 1; j >= 0 && cap(tokens[j]) && adjacent(tokens[j], tokens[j + 1]); j--) len++;
  for (let j = i + 1; j < tokens.length && cap(tokens[j]) && adjacent(tokens[j - 1], tokens[j]); j++) len++;
  return len;
}

/**
 * Derive the entity slugs for one fact. Returns subject-first content
 * order: explicit @-tags, then known/coined slugs by first appearance.
 * Capped so one fact can't flood entity_mentions.
 */
export function deriveEntitySlugs(
  content: string,
  taggedEntities: string[],
  knownSlugs: ReadonlySet<string>,
  maxSlugs = 8,
): string[] {
  const out: string[] = [];
  const have = new Set<string>();
  const add = (slug: string) => {
    if (!validateEntitySlug(slug) || have.has(slug)) return;
    have.add(slug);
    out.push(slug);
  };

  for (const tag of taggedEntities) add(slugify(tag));

  const tokens = tokenize(content);
  // Lowercase-as-typed words in this content: a capitalized token whose
  // lowercase form also appears is a prose word, not a name.
  const lowerWords = new Set(
    tokens.filter((t) => /^[a-z]/.test(t.raw)).map((t) => t.raw.toLowerCase()),
  );

  for (let i = 0; i < tokens.length && out.length < maxSlugs; i++) {
    const t = tokens[i];
    const token = normalizeToken(t.raw);
    const slug = slugify(token);
    if (!slug) continue;

    if (knownSlugs.has(slug)) {
      // Capitalization-faithful linking; digit coinages are case-free.
      if (/^[A-Z]/.test(token) || /\d/.test(slug)) add(slug);
      continue;
    }
    if (isNameShaped(token)) { add(slug); continue; }
    if (
      /^[A-Z][a-z]+$/.test(token) &&
      !isSentenceInitial(content, t.index) &&
      capitalizedRunLength(content, tokens, i) < 3 &&
      !lowerWords.has(token.toLowerCase())
    ) {
      add(slug);
    }
  }

  return out.slice(0, maxSlugs);
}

export function loadKnownEntitySlugs(db: InstanceType<typeof Database>): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT entity_slug FROM entity_mentions")
    .all() as Array<{ entity_slug: string }>;
  return new Set(rows.map((r) => r.entity_slug).filter(validateEntitySlug));
}

/**
 * One-time backfill (schema v13): purge junk entity slugs the old path let
 * through, then derive + link entities for every fact that has none.
 * Two passes so a fact mentioning an entity coined by a LATER fact still
 * links (the known-slug set grows during pass 1). Runs inside the
 * migration transaction; deterministic; safe on an empty DB.
 */
export function backfillEntityLinks(
  db: InstanceType<typeof Database>,
): { junkMentionsRemoved: number; factsLinked: number; mentionsAdded: number } {
  let junkMentionsRemoved = 0;
  const junkSlugs = (db
    .prepare("SELECT DISTINCT entity_slug FROM entity_mentions")
    .all() as Array<{ entity_slug: string }>)
    .map((r) => r.entity_slug)
    .filter((s) => !validateEntitySlug(s));
  const delStmt = db.prepare("DELETE FROM entity_mentions WHERE entity_slug = ?");
  for (const slug of junkSlugs) junkMentionsRemoved += delStmt.run(slug).changes;

  const known = loadKnownEntitySlugs(db);
  const unlinked = db
    .prepare(
      `SELECT id, content, entities FROM facts
       WHERE id NOT IN (SELECT DISTINCT fact_id FROM entity_mentions)
       ORDER BY id`
    )
    .all() as Array<{ id: number; content: string; entities: string }>;

  const insertMention = db.prepare(
    "INSERT OR IGNORE INTO entity_mentions (fact_id, entity_slug) VALUES (?, ?)"
  );
  const updateEntities = db.prepare("UPDATE facts SET entities = ? WHERE id = ?");

  let factsLinked = 0;
  let mentionsAdded = 0;
  const link = (factId: number, slugs: string[]): void => {
    for (const slug of slugs) mentionsAdded += insertMention.run(factId, slug).changes;
    updateEntities.run(JSON.stringify(slugs), factId);
    factsLinked++;
  };

  const stillUnlinked: Array<{ id: number; content: string }> = [];
  for (const row of unlinked) {
    let tagged: string[] = [];
    try { tagged = JSON.parse(row.entities || "[]"); } catch {}
    const slugs = deriveEntitySlugs(row.content, tagged, known);
    if (slugs.length === 0) { stillUnlinked.push(row); continue; }
    link(row.id, slugs);
    for (const slug of slugs) known.add(slug);
  }

  // Pass 2: the known-slug set now includes every entity coined in pass 1.
  for (const row of stillUnlinked) {
    const slugs = deriveEntitySlugs(row.content, [], known);
    if (slugs.length > 0) link(row.id, slugs);
  }

  return { junkMentionsRemoved, factsLinked, mentionsAdded };
}
