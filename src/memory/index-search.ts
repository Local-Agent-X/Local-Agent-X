import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { Chunk, EmbeddingProvider, FactKind, MemoryConfig, MemorySearchResult } from "./types.js";
import {
  toSearchResult, mergeHybridResults,
  applyTemporalDecay, applyTemporalQueryBoost, mmrRerank,
} from "./search-helpers.js";
import { parseDateRange, dateInRange } from "./date-parser.js";
import {
  bm25RankToScore, buildFtsQuery, cosineSimilarity, extractKeywords, slugify,
} from "./utils.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.index-search");

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  sources?: string[];
  entities?: string[];
  since?: Date;
  kind?: FactKind;
  project?: string;
  sourceType?: string;
  dateFrom?: string;
  dateTo?: string;
  rerank?: boolean;
  rerankModel?: string;
  sessionId?: string;
  hyde?: boolean;
  hydeProvider?: "ollama" | "anthropic" | "openai" | "auto";
  hydeModel?: string;
}

export interface SearchDeps {
  db: InstanceType<typeof Database>;
  embeddingProvider: EmbeddingProvider | null;
  config: MemoryConfig;
  hasFts: boolean;
  sync: () => Promise<void>;
}

export async function searchInIndex(
  deps: SearchDeps,
  query: string,
  options?: SearchOptions
): Promise<MemorySearchResult[]> {
  await deps.sync();

  const maxResults = options?.maxResults || deps.config.maxResults;
  const minScore = options?.minScore || deps.config.minScore;
  const candidateLimit = Math.min(
    200,
    Math.max(1, maxResults * deps.config.candidateMultiplier)
  );

  let keywordResults: Array<Chunk & { score: number }> = [];
  let vectorResults: Array<Chunk & { score: number }> = [];

  if (deps.hasFts) {
    keywordResults = searchKeyword(deps.db, query, candidateLimit, options?.sources);

    if (keywordResults.length === 0) {
      const keywords = extractKeywords(query);
      for (const kw of keywords) {
        const partial = searchKeyword(deps.db, kw, candidateLimit, options?.sources);
        keywordResults.push(...partial);
      }
      const deduped = new Map<number, (typeof keywordResults)[0]>();
      for (const r of keywordResults) {
        const existing = deduped.get(r.id!);
        if (!existing || r.score > existing.score) {
          deduped.set(r.id!, r);
        }
      }
      keywordResults = [...deduped.values()];
    }
  }

  if (deps.embeddingProvider) {
    try {
      let embedText = query;
      if (options?.hyde) {
        const { generateHyDE } = await import("../memory-hyde.js");
        const hyp = await generateHyDE(query, { provider: options.hydeProvider, model: options.hydeModel });
        if (hyp) embedText = hyp;
      }
      const queryVec = await deps.embeddingProvider.embed(embedText);
      vectorResults = searchVector(deps.db, queryVec, candidateLimit, options?.sources);
    } catch (e) {
      logger.warn("[memory] Vector search failed:", (e as Error).message);
    }
  }

  let merged: MemorySearchResult[];
  if (keywordResults.length > 0 && vectorResults.length > 0) {
    merged = mergeHybridResults(
      keywordResults,
      vectorResults,
      deps.config.vectorWeight,
      deps.config.textWeight,
      deps.config.snippetMaxChars
    );
  } else if (vectorResults.length > 0) {
    merged = vectorResults.map((c) => toSearchResult(c, deps.config.snippetMaxChars));
  } else {
    merged = keywordResults.map((c) => toSearchResult(c, deps.config.snippetMaxChars));

    if (!deps.embeddingProvider && merged.length > 0) {
      const relaxedMin = Math.min(minScore, deps.config.textWeight);
      let processed = postProcess(deps.db, deps.config, merged, maxResults * 3, relaxedMin, { ...options, query });
      if (options?.rerank && processed.length > 0) {
        try { const { rerankWithLLM } = await import("../memory-reranker.js"); const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel }); } catch (e) { logger.warn("[memory] Rerank error:", (e as Error).message); }
      }
      return processed.slice(0, maxResults);
    }
  }

  let processed = postProcess(deps.db, deps.config, merged, maxResults * 3, minScore, { ...options, query });

  if (options?.rerank && processed.length > 0) {
    try {
      const { rerankWithLLM } = await import("../memory-reranker.js");
      const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel });
    } catch (e) { logger.warn("[memory] Rerank failed:", (e as Error).message); }
  }

  return processed.slice(0, maxResults);
}

function postProcess(
  db: InstanceType<typeof Database>,
  config: MemoryConfig,
  results: MemorySearchResult[],
  maxResults: number,
  minScore: number,
  options?: { since?: Date; entities?: string[]; kind?: FactKind; project?: string; sourceType?: string; dateFrom?: string; dateTo?: string; query?: string }
): MemorySearchResult[] {
  results = applySessionGrouping(results);

  if (options?.query) {
    const range = parseDateRange(options.query);
    if (range) {
      if (range.confidence === "hard") {
        const filtered = results.filter(r => {
          const d = r.metadata?.date;
          if (!d) return true;
          return dateInRange(d, range);
        });
        if (filtered.some(r => r.metadata?.date && dateInRange(r.metadata.date, range))) {
          results = filtered;
        }
      } else {
        for (const r of results) {
          if (r.metadata?.date && dateInRange(r.metadata.date, range)) {
            r.score = Math.min(1, r.score + 0.20);
          }
        }
        results.sort((a, b) => b.score - a.score);
      }
    }
    results = applyTemporalQueryBoost(results, options.query);
  }

  if (config.temporalDecayEnabled) {
    results = applyTemporalDecay(results, config.temporalHalfLifeDays);
  }

  if (config.mmrEnabled) {
    results = mmrRerank(results, maxResults, config.mmrLambda);
  }

  if (options?.since) {
    const sinceMs = options.since.getTime();
    results = results.filter((r) => {
      const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) return true;
      return new Date(dateMatch[1]).getTime() >= sinceMs;
    });
  }

  if (options?.entities && options.entities.length > 0) {
    const slugs = new Set(options.entities.map((e) => slugify(e)));
    results = results.filter((r) => {
      if (!r.entities || r.entities.length === 0) return true;
      return r.entities.some((e) => slugs.has(slugify(e)));
    });
  }

  if (options?.project || options?.sourceType || options?.dateFrom || options?.dateTo) {
    results = results.filter((r) => {
      const meta = r.metadata;
      if (!meta) return false;
      if (options.project && meta.project !== options.project) return false;
      if (options.sourceType && meta.source_type !== options.sourceType) return false;
      if (options.dateFrom && (!meta.date || meta.date < options.dateFrom)) return false;
      if (options.dateTo && (!meta.date || meta.date > options.dateTo)) return false;
      return true;
    });
  }

  return results.filter((r) => r.score >= minScore).slice(0, maxResults);
}

export function applyGraphBoost(
  db: InstanceType<typeof Database>,
  traverseFromFn: (entity: string, maxHops: number) => Set<string>,
  results: MemorySearchResult[],
  query: string
): MemorySearchResult[] {
  if (results.length === 0) return results;

  const candidates = new Set<string>();
  const words = query.split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9-]/g, "");
    if (clean.length >= 2 && /^[A-Z]/.test(w)) {
      candidates.add(slugify(clean));
    }
  }
  if (candidates.size < 2) return results;

  const connectedEntities = new Set<string>();
  for (const entity of candidates) {
    const reachable = traverseFromFn(entity, 1);
    for (const r of reachable) connectedEntities.add(r);
  }
  if (connectedEntities.size === 0) return results;

  if (connectedEntities.size >= 15) return results;

  const GRAPH_BOOST = 0.08;
  for (const r of results) {
    if (!r.entities || r.entities.length === 0) continue;
    const hit = r.entities.some((e) => connectedEntities.has(slugify(e)));
    if (hit) {
      r.score = Math.min(1, r.score + GRAPH_BOOST);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function applySessionGrouping(results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length === 0) return results;
  const sessionScores = new Map<string, number>();
  for (const r of results) {
    const sid = r.metadata?.session_id;
    if (!sid) continue;
    const existing = sessionScores.get(sid) || 0;
    if (r.score > existing) sessionScores.set(sid, r.score);
  }
  if (sessionScores.size === 0) return results;

  const GROUPING_BOOST = 0.2;
  for (const r of results) {
    const sid = r.metadata?.session_id;
    if (!sid) continue;
    const topScore = sessionScores.get(sid) || 0;
    if (r.score < topScore) {
      r.score = Math.min(1, r.score + topScore * GROUPING_BOOST);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function searchKeyword(
  db: InstanceType<typeof Database>,
  query: string,
  limit: number,
  sources?: string[]
): Array<Chunk & { score: number }> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, c.metadata,
                bm25(chunks_fts) as rank
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      metadata: string | null;
      rank: number;
    }>;

    return rows
      .filter((r) => !sources || sources.includes(r.source))
      .map((r) => ({
        id: r.id,
        path: r.path,
        source: r.source,
        startLine: r.start_line,
        endLine: r.end_line,
        text: r.text,
        hash: "",
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        score: bm25RankToScore(r.rank),
      }));
  } catch {
    return [];
  }
}

function searchVector(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[]
): Array<Chunk & { score: number }> {
  const BATCH_SIZE = 1000;
  const sourceFilter = sources ? `AND source IN (${sources.map(() => "?").join(",")})` : "";
  const params = sources ? [...sources] : [];

  const totalCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM chunks WHERE embedding IS NOT NULL ${sourceFilter}`
      )
      .get(...params) as { n: number }
  ).n;

  const results: Array<Chunk & { score: number }> = [];
  let minResultScore = -Infinity;

  for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
    const batch = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, embedding, metadata
         FROM chunks WHERE embedding IS NOT NULL ${sourceFilter}
         LIMIT ? OFFSET ?`
      )
      .all(...params, BATCH_SIZE, offset) as Array<{
      id: number;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      metadata: string | null;
    }>;

    for (const row of batch) {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding);
      } catch {
        continue;
      }

      const similarity = cosineSimilarity(queryVec, embedding);
      if (!Number.isFinite(similarity)) continue;

      if (results.length < limit * 2 || similarity > minResultScore) {
        results.push({
          id: row.id,
          path: row.path,
          source: row.source,
          startLine: row.start_line,
          endLine: row.end_line,
          text: row.text,
          hash: "",
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          score: similarity,
        });

        if (results.length > limit * 4) {
          results.sort((a, b) => b.score - a.score);
          results.length = limit * 2;
          minResultScore = results[results.length - 1].score;
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
