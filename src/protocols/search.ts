/**
 * protocol(action:'search') — keyword-based ranked discovery over the protocol catalog.
 *
 * The default install ships a small curated set of typed built-in protocols.
 * Users can grow the catalog by importing optional SKILL.md packs (bundled
 * layer) or authoring their own (imported / custom layers). Even at small
 * sizes search is preferred over list-browse so the system prompt stays
 * lean; once a user has imported a large pack, search keeps name+description
 * out of every-turn context.
 *
 * Ranking: BM25-lite — IDF-weighted term frequency over a denormalized
 * document built from name + description + triggers + tags + first 800
 * chars of body/steps. No embeddings, no external deps. Index is rebuilt
 * lazily on the first call after a protocol-list mutation; rebuild stays
 * sub-100ms in Node up to ~1,000 docs.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import type { Protocol } from "../protocols/index.js";
import { getAllProtocols } from "../protocols/index.js";
import { isTopicallyEmpty } from "./generic-terms.js";
import { recordUsage } from "./usage.js";

interface IndexedDoc {
  name: string;
  category?: string;
  description: string;
  /** Per-term frequency in this doc */
  tf: Map<string, number>;
  /** Total terms (for BM25 length normalization) */
  length: number;
  /** Terms from the protocol's IDENTITY only — name, triggers, description,
   *  tags. What the protocol claims to be about, as opposed to prose that
   *  happens to be inside it. The relevance gate reads this; ranking doesn't. */
  identity: Set<string>;
}

interface SearchIndex {
  docs: IndexedDoc[];
  /** Document frequency per term — how many docs contain it */
  df: Map<string, number>;
  /** Average doc length, used by BM25 length normalization */
  avgLen: number;
}

let _index: SearchIndex | null = null;
let _indexedCount = 0;

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","is","it","for","on","with","by","at","be","as","this","that","from","you","i",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 32 && !STOPWORDS.has(t));
}

function buildDoc(p: Protocol): IndexedDoc {
  const stepText = (p.steps || []).map((s) => `${s.id} ${s.instruction || ""}`).join(" ");
  const bodyHead = (p.body || "").slice(0, 800);
  const triggers = (p.triggers || []).join(" ");
  const tags = (p.tags || []).join(" ");
  const text = `${p.name} ${p.description || ""} ${triggers} ${tags} ${stepText} ${bodyHead}`;

  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  return {
    name: p.name,
    category: p.category,
    description: p.description || "",
    tf,
    length: tokens.length,
    identity: new Set(tokenize(`${p.name} ${p.description || ""} ${triggers} ${tags}`)),
  };
}

function buildIndex(protocols: Protocol[]): SearchIndex {
  const docs = protocols.map(buildDoc);
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const term of d.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const totalLen = docs.reduce((sum, d) => sum + d.length, 0);
  const avgLen = docs.length > 0 ? totalLen / docs.length : 0;
  return { docs, df, avgLen };
}

function getOrBuildIndex(): SearchIndex {
  const protocols = getAllProtocols();
  if (!_index || _indexedCount !== protocols.length) {
    _index = buildIndex(protocols);
    _indexedCount = protocols.length;
  }
  return _index;
}

/** Drop the cached index. Called from saveCustomProtocols() — the single write
 *  choke point for custom.json, so create/edit/delete/archive/unarchive and
 *  marketplace installs all land here.
 *
 *  Boundary, stated exactly: this covers the CUSTOM tier only. The
 *  `_indexedCount` check above catches a SKILL.md appearing on or vanishing
 *  from disk, because that changes the count. Neither mechanism sees a
 *  SKILL.md rewritten IN PLACE — learned-lifecycle.ts does that on activate —
 *  so a re-activated learned protocol's new text stays invisible to search
 *  for the rest of the process's life. Recorded, owned by the learned tier. */
export function invalidateSearchIndex(): void {
  _index = null;
  _indexedCount = 0;
}

// BM25 parameters — standard defaults. Tuned for short docs.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface RankedHit {
  name: string;
  description: string;
  category?: string;
  score: number;
  /** How many DISTINCT query terms this doc contains anywhere. */
  matched: number;
  /** How many of those are TOPICAL terms in the doc's IDENTITY. The gate reads
   *  this; BM25's score, computed over every field including the body and every
   *  term including the generic ones, does the ranking. */
  matchedIdentity: number;
}

/**
 * Relevance gate — what a document has to share with the query before it counts
 * as a hit at all.
 *
 * Before this existed the filter was `score > 0`, i.e. **one shared token made
 * a hit**. That produced the miss that motivated this: searching "purchase
 * order" against a catalog with no purchasing protocol returned
 * `instagram_post` and recorded `hit:true`, because a step instruction contains
 * the word "order". A confident wrong answer is worse than a miss — the miss is
 * what tells the caller to write the protocol.
 *
 * The rule, stated rather than tuned: **at least one query term must appear in
 * what the protocol claims to BE — its name, triggers, description or tags.**
 * The body still ranks (a protocol that discusses your query at length ranks
 * above one that merely mentions it), but body prose alone cannot create a hit.
 * A protocol whose entire self-description shares no word with the query is not
 * about the query, however many words its prose happens to contain.
 *
 * Why not "at least N matched terms anywhere", which is what this was first:
 * that rule INVERTS WITH QUERY LENGTH. Measured on the real catalog, adding a
 * descriptive word removed the correct answer — `research` found `web_research`
 * but `company research` found nothing; `slack` found `send_slack` but
 * `slack webhook` found nothing; `roll back a deploy` missed `deploy`. Making a
 * request more descriptive must not make it less answerable. It also failed on
 * the defect it was written for: `create purchase order` still returned
 * `instagram_post`, because "create" and "order" are two body words, and the
 * tool's own "retry with one distinctive word" advice reduced the gate to
 * `score > 0` again (bare `order` → `instagram_post`, `hit:true`).
 *
 * Why this rule is safe where a threshold isn't: it reads only the query and
 * the document — no document frequency, no score cut. It cannot drift with
 * catalog size (BM25's IDF moves with N, so any absolute score cut would) and
 * it cannot invert with catalog composition: adding more protocols about a
 * topic can never turn a passing hit into a failing one. That inversion — the
 * more the agent writes about the user's work, the less of it can be retrieved
 * — is the failure this subsystem has already been bitten by twice.
 *
 * Known cost, stated: a query whose only overlap is body prose now misses
 * (e.g. "hashtags", which no protocol names or describes, only mentions).
 * That is the same class of miss the rule exists to produce, and a miss is
 * recoverable — it tells the agent the catalog has a gap.
 *
 * One refinement, and it is where the second half of the rule comes from: the
 * matched identity term must also be TOPICAL. `roll back a deploy` → `deploy`
 * and `create purchase order` → `git_workflow` are otherwise structurally
 * identical — one of three query terms, matched in the label, nothing in
 * description or body — so the only thing separating a real hit from a junk one
 * is that "deploy" names a subject and "create" names a kind of action. That
 * judgment comes from the shared, closed `GENERIC_TERMS`/`STOP_TERMS` sets in
 * ./generic-terms.js, NOT from document frequency: a closed list cannot move
 * when the catalog grows, whereas "rare in this corpus" would make every word
 * less admissible as the agent writes more protocols about the user's work.
 */
function rank(query: string, idx: SearchIndex, limit: number): RankedHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  const N = idx.docs.length;
  if (N === 0) return [];

  // Topical terms only gate ADMISSION. Every term still scores, so a generic
  // word the protocol genuinely uses can still lift its rank — it just cannot
  // be the sole reason the protocol is called a match.
  const topical = new Set(qTokens.filter((t) => !isTopicallyEmpty(t)));

  const scored: RankedHit[] = idx.docs.map((d) => {
    let score = 0;
    let matched = 0;
    let matchedIdentity = 0;
    for (const term of qTokens) {
      const tf = d.tf.get(term) || 0;
      if (tf === 0) continue;
      matched += 1;
      if (d.identity.has(term) && topical.has(term)) matchedIdentity += 1;
      const dfTerm = idx.df.get(term) || 0;
      const idf = Math.log(1 + (N - dfTerm + 0.5) / (dfTerm + 0.5));
      const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.length / (idx.avgLen || 1))));
      score += idf * norm;
    }
    return { name: d.name, description: d.description, category: d.category, score, matched, matchedIdentity };
  });

  return scored
    .filter((h) => h.score > 0 && h.matchedIdentity >= 1)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Ranked search over the live catalog — the exact path protocol(action:'search')
 *  takes, minus the usage-telemetry write. Exported so the relevance gate can be
 *  measured against a real catalog without every measurement appending a
 *  "searched" row to the user's usage log. */
export function rankProtocols(query: string, limit = 10): RankedHit[] {
  return rank(query, getOrBuildIndex(), limit);
}

export function createProtocolSearchTool(): ToolDefinition {
  return {
    name: "protocol_search",
    description:
      "Find protocols by keyword. Returns the top-N matches ranked by relevance to your query. " +
      "Use this whenever you suspect a protocol exists for the current task — saves you from guessing names. " +
      "Once you pick a hit, call `protocol(action:'get')` on its `name` to load the full record. " +
      "A protocol only counts as a hit when your query touches what it says it is — its name, triggers, " +
      "description or tags — not merely a word buried in its body, so an empty result means the catalog has no " +
      "protocol for this task rather than that you phrased it badly. " +
      "Tip: include domain words from the user's request (e.g. \"stripe checkout\", \"ig caption\", \"git rebase\").",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query. 1-6 words is ideal." },
        limit: { type: "integer", description: "Max hits to return. Default 10, cap 25." },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = String((args as { query?: string }).query || "").trim();
      if (!query) return { content: "query is required", isError: true };
      const rawLimit = Number((args as { limit?: number }).limit ?? 10);
      const limit = Math.max(1, Math.min(25, Number.isFinite(rawLimit) ? rawLimit : 10));

      const hits = rankProtocols(query, limit);
      // Record the search regardless of outcome — misses are the signal that
      // tells us where the catalog has gaps. `name` carries the top hit (or
      // empty on miss) so the same record covers "what did we recommend"
      // without a second event type.
      recordUsage({
        action: "searched",
        name: hits[0]?.name || "",
        query,
        hit: hits.length > 0,
        sessionId: typeof (args as { _sessionId?: string })._sessionId === "string" ? (args as { _sessionId: string })._sessionId : undefined,
      });
      if (hits.length === 0) {
        return { content: `No protocol in the catalog is about "${query}" (nothing matched on its name, triggers, description or tags). Try the user's own domain words, call protocol(action:'list') to browse the full catalog, or treat this as a gap worth writing a protocol for.` };
      }
      const lines = hits.map((h, i) => {
        const cat = h.category ? `[${h.category}] ` : "";
        const desc = h.description.length > 120 ? h.description.slice(0, 117) + "..." : h.description;
        return `${i + 1}. ${cat}${h.name} — ${desc}`;
      });
      lines.push("", `Call \`protocol(action:'get') { name: "<name from above>" }\` to load the full record.`);
      return { content: lines.join("\n") };
    },
  };
}
