import type { Chunk, MemorySearchResult } from "../types.js";
import { toSearchResult, mergeHybridResults, type IdentifiedSearchResult } from "../search-helpers.js";
import { createLogger } from "../../logger.js";
import type { SearchDeps, SearchOptions } from "./types.js";
import { searchKeyword } from "./keyword-search.js";
import { searchVectorOffThread } from "./vector-search.js";
import { postProcess, applyGraphBoost } from "./post-process.js";
import { traverseFrom } from "../index-relations.js";

const logger = createLogger("memory.index-search");

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

  // Same-session filter pushed into SQL when caller hasn't opted into
  // cross-session. Profile scope comes from chunks.source; nullable IDs never
  // turn session-scoped rows into profile memory.
  const sqlSessionFilter = options?.crossSession
    ? undefined
    : options?.sessionId ?? null;

  if (deps.hasFts) {
    keywordResults = searchKeyword(deps.db, query, candidateLimit, options?.sources, sqlSessionFilter);

    // Every-word missed: relax to any-word in ONE query. This used to issue a
    // separate synchronous query PER KEYWORD, duplicates included — and
    // better-sqlite3 is synchronous, so the event loop was frozen for all of
    // them. A long message nearly always misses every-word, so a pasted
    // coding exercise (330 keywords) ran 330 queries, materialized 53k rows —
    // 57% of the whole index — and blocked the server 5-8s per turn, starving
    // every other request (2026-09-16).
    if (keywordResults.length === 0) {
      keywordResults = searchKeyword(deps.db, query, candidateLimit, options?.sources, sqlSessionFilter, "any");
    }
  }

  if (deps.embeddingProvider) {
    try {
      let embedText = query;
      if (options?.hyde) {
        const { generateHyDE } = await import("../hyde.js");
        const hyp = await generateHyDE(query, { provider: options.hydeProvider, model: options.hydeModel });
        if (hyp) embedText = hyp;
      }
      const queryVec = await deps.embeddingProvider.embed(embedText);
      vectorResults = await searchVectorOffThread(deps.db, queryVec, candidateLimit, options?.sources, sqlSessionFilter);
    } catch (e) {
      logger.warn("[memory] Vector search failed:", (e as Error).message);
    }
  }

  let merged: IdentifiedSearchResult[];
  if (keywordResults.length > 0 && vectorResults.length > 0) {
    merged = mergeHybridResults(
      keywordResults,
      vectorResults,
      deps.config.vectorWeight,
      deps.config.textWeight,
      deps.config.snippetMaxChars,
      query,
    );
    // A chunk found ONLY by FTS merges to textWeight×score, which (with
    // textWeight 0.3 < minScore 0.35) can mathematically never pass the
    // score floor — an exact keyword match that missed the vector top-K was
    // dropped as "no relevant memories". Missing from the vector top-K is
    // absent evidence, not zero relevance: rescore keyword-only hits on
    // their raw FTS scale, matching what the no-embedding branch returns.
    //
    // "Keyword-only" MUST be decided by chunk IDENTITY (id), not by
    // `path:startLine` — chunkConversationPairs stamps every split part of a
    // long answer with the SAME startLine, so a keyword-only later part would
    // collide with a vector-found sibling on a positional key, be misclassified
    // as vector-found, denied this rescore, and dropped. That is the very
    // non-unique key hybridMergeKey was written to reject.
    //
    // The same rescore is a FLOOR for a chunk both channels found: a weak
    // vector match is not evidence against an exact keyword one. Blending
    // alone scored an every-word hit 0.7×0.17 + 0.3×0.5 = 0.27 — under the
    // floor, when missing the vector top-K would have scored it 0.70. A
    // one-word past-session search ("Merriweather") returned nothing, the
    // user's own message among the dropped, and the agent took a true fact
    // back (eval run, 2026-10-08).
    if (deps.config.textWeight > 0) {
      const keywordScore = new Map(keywordResults.map((r) => [r.id, r.score]));
      for (const r of merged) {
        const k = keywordScore.get(r.id);
        if (k === undefined) continue;
        // Cap the rescored keyword score at vectorWeight, the ceiling of
        // a vector-only hit (vectorWeight×score, score≤1). Rescoring up to 1.0
        // let a keyword-only hit outrank every vector hit, inverting the
        // configured vectorWeight>textWeight priority for disjoint hits.
        r.score = Math.max(r.score, Math.min(deps.config.vectorWeight, k / deps.config.textWeight));
      }
      merged.sort((a, b) => b.score - a.score);
    }
  } else if (vectorResults.length > 0) {
    merged = vectorResults.map((c) => toSearchResult(c, deps.config.snippetMaxChars, query));
  } else {
    merged = keywordResults.map((c) => toSearchResult(c, deps.config.snippetMaxChars, query));

    if (!deps.embeddingProvider && merged.length > 0) {
      const relaxedMin = Math.min(minScore, deps.config.textWeight);
      let processed = postProcess(deps.db, deps.config, merged, maxResults * 3, relaxedMin, { ...options, query });
      processed = applyGraphBoost((e, h) => traverseFrom(deps.db, e, h), processed, query);
      if (options?.rerank && processed.length > 0) {
        try { const { rerankWithLLM } = await import("../reranker.js"); const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel }); } catch (e) { logger.warn("[memory] Rerank error:", (e as Error).message); }
      }
      return processed.slice(0, maxResults);
    }
  }

  let processed = postProcess(deps.db, deps.config, merged, maxResults * 3, minScore, { ...options, query });
  processed = applyGraphBoost((e, h) => traverseFrom(deps.db, e, h), processed, query);

  if (options?.rerank && processed.length > 0) {
    try {
      const { rerankWithLLM } = await import("../reranker.js");
      const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel });
    } catch (e) { logger.warn("[memory] Rerank failed:", (e as Error).message); }
  }

  return processed.slice(0, maxResults);
}
