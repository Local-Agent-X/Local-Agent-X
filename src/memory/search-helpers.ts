/**
 * Search helpers — pure ranking, fusion, re-ranking, and chunking functions.
 *
 * These take data in and return data out. No DB access, no class state.
 * Used by MemoryIndex's search pipeline.
 */
import { basename } from "node:path";
import type { Chunk, MemorySearchResult } from "./types.js";
import { sha256, tokenize, jaccardSimilarity, normalizeScores } from "./utils.js";

// ── Chunking ──

export function chunkText(
  content: string,
  path: string,
  source: string,
  maxChunkChars: number,
  overlapChars: number
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentText = "";
  let currentStart = 1;
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentText += (currentText ? "\n" : "") + line;
    currentChars += line.length + 1;

    if (currentChars >= maxChunkChars || i === lines.length - 1) {
      if (currentText.trim()) {
        chunks.push({
          path,
          source,
          startLine: currentStart,
          endLine: i + 1,
          text: currentText,
          hash: sha256(currentText),
        });
      }

      if (i < lines.length - 1) {
        const overlapText = currentText.slice(-overlapChars);
        const overlapLines = overlapText.split("\n").length;
        currentStart = i + 2 - overlapLines;
        currentText = overlapText;
        currentChars = overlapText.length;
      } else {
        currentText = "";
        currentChars = 0;
        currentStart = i + 2;
      }
    }
  }

  return chunks;
}

// ── Result converter ──

export function toSearchResult(
  chunk: Chunk & { score: number },
  snippetMaxChars: number
): MemorySearchResult {
  const entityMatches = chunk.text.match(/@([\w-]+)/g) || [];
  const entities = entityMatches.map((m) => m.slice(1));

  let metadata = chunk.metadata;
  if (!metadata && (chunk as unknown as { metadataRaw?: string }).metadataRaw) {
    try { metadata = JSON.parse((chunk as unknown as { metadataRaw: string }).metadataRaw); } catch {}
  }

  return {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: chunk.score,
    snippet: chunk.text.slice(0, snippetMaxChars),
    source: chunk.source as MemorySearchResult["source"],
    entities: entities.length > 0 ? entities : undefined,
    metadata,
  };
}

// ── Hybrid merge (BM25 + vector) ──

export function mergeHybridResults(
  keywordResults: Array<Chunk & { score: number }>,
  vectorResults: Array<Chunk & { score: number }>,
  vectorWeight: number,
  textWeight: number,
  snippetMaxChars: number
): MemorySearchResult[] {
  const merged = new Map<
    string,
    { chunk: Chunk; vectorScore: number; textScore: number }
  >();

  for (const r of vectorResults) {
    const key = `${r.path}:${r.startLine}`;
    merged.set(key, { chunk: r, vectorScore: r.score, textScore: 0 });
  }

  for (const r of keywordResults) {
    const key = `${r.path}:${r.startLine}`;
    const existing = merged.get(key);
    if (existing) {
      existing.textScore = r.score;
    } else {
      merged.set(key, { chunk: r, vectorScore: 0, textScore: r.score });
    }
  }

  const results: MemorySearchResult[] = [];
  for (const [, entry] of merged) {
    const score = vectorWeight * entry.vectorScore + textWeight * entry.textScore;
    results.push(toSearchResult({ ...entry.chunk, score }, snippetMaxChars));
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Temporal decay (date-stamped files get older = lower score) ──

export function applyTemporalDecay(
  results: MemorySearchResult[],
  halfLifeDays: number
): MemorySearchResult[] {
  const now = Date.now();
  const lambda = Math.LN2 / halfLifeDays;

  return results.map((r) => {
    const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return r;
    const fileDate = new Date(dateMatch[1]).getTime();
    if (isNaN(fileDate)) return r;
    const ageDays = Math.max(0, (now - fileDate) / (1000 * 60 * 60 * 24));
    const multiplier = Math.exp(-lambda * ageDays);
    return { ...r, score: r.score * multiplier };
  });
}

// ── Temporal query boost ──

/** Extract date references from a query and boost chunks whose metadata.date matches. */
export function applyTemporalQueryBoost(results: MemorySearchResult[], query: string): MemorySearchResult[] {
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };
  const queryLower = query.toLowerCase();
  const targetDates: string[] = [];

  for (const [name, num] of Object.entries(months)) {
    const yearMatch = queryLower.match(new RegExp(name + "\\s+(\\d{4})"));
    if (yearMatch) targetDates.push(`${yearMatch[1]}-${num}`);
    else if (queryLower.includes(name)) targetDates.push(`-${num}-`);
  }
  const isoMatch = queryLower.match(/(\d{4}-\d{2}-\d{2})/g);
  if (isoMatch) targetDates.push(...isoMatch);

  if (targetDates.length === 0) return results;

  const TEMPORAL_BOOST = 0.15;
  for (const r of results) {
    const chunkDate = r.metadata?.date || "";
    if (!chunkDate) continue;
    for (const target of targetDates) {
      if (chunkDate.includes(target)) {
        r.score = Math.min(1, r.score + TEMPORAL_BOOST);
        break;
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── MMR diversity re-ranking ──

export function mmrRerank(
  results: MemorySearchResult[],
  limit: number,
  lambda: number
): MemorySearchResult[] {
  if (results.length <= 1) return results;

  const scored = results.map((r) => ({ ...r }));
  normalizeScores(scored);

  const tokenSets = scored.map((r) => tokenize(r.snippet));

  const selected: number[] = [];
  const remaining = new Set(scored.map((_, i) => i));

  while (selected.length < limit && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const relevance = scored[idx].score;
      let maxSim = 0;
      for (const selIdx of selected) {
        const sim = jaccardSimilarity(tokenSets[idx], tokenSets[selIdx]);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr || (mmr === bestMmr && results[idx].score > results[bestIdx]?.score)) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return selected.map((i) => results[i]);
}
