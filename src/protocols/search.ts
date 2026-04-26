/**
 * protocol_search — keyword-based ranked discovery over the protocol catalog.
 *
 * With ~1,000 protocols in the bundle, listing every name+description in the
 * system prompt would burn ~150KB of token budget per turn. Instead the
 * system prompt mentions only this search tool; the agent calls it when it
 * thinks a protocol might exist for the current task, gets the top N hits,
 * then calls protocol_get on the chosen one.
 *
 * Ranking: BM25-lite — IDF-weighted term frequency over a denormalized
 * document built from name + description + triggers + tags + first 800
 * chars of body/steps. No embeddings, no external deps. Index is rebuilt
 * lazily on the first call after a protocol-list mutation; for ~1,000
 * docs the rebuild is sub-100ms in Node.
 */

import type { ToolDefinition, ToolResult } from "../types.js";
import type { Protocol } from "../protocols.js";
import { getAllProtocols } from "../protocols.js";

interface IndexedDoc {
  name: string;
  category?: string;
  description: string;
  /** Per-term frequency in this doc */
  tf: Map<string, number>;
  /** Total terms (for BM25 length normalization) */
  length: number;
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

/** Drop the cached index. Call after the catalog changes (create/edit/delete). */
export function invalidateSearchIndex(): void {
  _index = null;
  _indexedCount = 0;
}

// BM25 parameters — standard defaults. Tuned for short docs.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface RankedHit {
  name: string;
  description: string;
  category?: string;
  score: number;
}

function rank(query: string, idx: SearchIndex, limit: number): RankedHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const N = idx.docs.length;
  if (N === 0) return [];

  const scored: RankedHit[] = idx.docs.map((d) => {
    let score = 0;
    for (const term of qTokens) {
      const tf = d.tf.get(term) || 0;
      if (tf === 0) continue;
      const dfTerm = idx.df.get(term) || 0;
      const idf = Math.log(1 + (N - dfTerm + 0.5) / (dfTerm + 0.5));
      const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.length / (idx.avgLen || 1))));
      score += idf * norm;
    }
    return { name: d.name, description: d.description, category: d.category, score };
  });

  return scored
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function createProtocolSearchTool(): ToolDefinition {
  return {
    name: "protocol_search",
    description:
      "Find protocols by keyword. Returns the top-N matches ranked by relevance to your query. " +
      "Use this whenever you suspect a protocol exists for the current task — saves you from guessing names. " +
      "Once you pick a hit, call `protocol_get` on its `name` to load the full record. " +
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

      const idx = getOrBuildIndex();
      const hits = rank(query, idx, limit);
      if (hits.length === 0) {
        return { content: `No protocols matched "${query}". Try different keywords, or call protocol_list to browse the full catalog.` };
      }
      const lines = hits.map((h, i) => {
        const cat = h.category ? `[${h.category}] ` : "";
        const desc = h.description.length > 120 ? h.description.slice(0, 117) + "..." : h.description;
        return `${i + 1}. ${cat}${h.name} — ${desc}`;
      });
      lines.push("", `Call \`protocol_get { name: "<name from above>" }\` to load the full record.`);
      return { content: lines.join("\n") };
    },
  };
}
