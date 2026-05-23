import type { Chunk, MemorySearchResult } from "../types.js";
import { toSearchResult, mergeHybridResults } from "../search-helpers.js";
import { extractKeywords } from "../utils.js";
import { createLogger } from "../../logger.js";
import type { SearchDeps, SearchOptions } from "./types.js";
import { searchKeyword } from "./keyword-search.js";
import { searchVector } from "./vector-search.js";
import { postProcess } from "./post-process.js";

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
  // cross-session. Profile-level chunks (session_id IS NULL) always pass
  // because they describe the user as a stable entity, not a conversation.
  const sqlSessionFilter = options?.sessionId && !options?.crossSession
    ? options.sessionId
    : undefined;

  if (deps.hasFts) {
    keywordResults = searchKeyword(deps.db, query, candidateLimit, options?.sources, sqlSessionFilter);

    if (keywordResults.length === 0) {
      const keywords = extractKeywords(query);
      for (const kw of keywords) {
        const partial = searchKeyword(deps.db, kw, candidateLimit, options?.sources, sqlSessionFilter);
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
        const { generateHyDE } = await import("../../memory-hyde.js");
        const hyp = await generateHyDE(query, { provider: options.hydeProvider, model: options.hydeModel });
        if (hyp) embedText = hyp;
      }
      const queryVec = await deps.embeddingProvider.embed(embedText);
      vectorResults = searchVector(deps.db, queryVec, candidateLimit, options?.sources, sqlSessionFilter);
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
        try { const { rerankWithLLM } = await import("../../memory-reranker.js"); const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel }); } catch (e) { logger.warn("[memory] Rerank error:", (e as Error).message); }
      }
      return processed.slice(0, maxResults);
    }
  }

  let processed = postProcess(deps.db, deps.config, merged, maxResults * 3, minScore, { ...options, query });

  if (options?.rerank && processed.length > 0) {
    try {
      const { rerankWithLLM } = await import("../../memory-reranker.js");
      const rProvider = options.rerankModel?.startsWith("provider:") ? options.rerankModel.split(":")[1] : "ollama";
      const rModel = options.rerankModel?.startsWith("provider:") ? undefined : options.rerankModel;
      processed = await rerankWithLLM(query, processed, { provider: rProvider, model: rModel });
    } catch (e) { logger.warn("[memory] Rerank failed:", (e as Error).message); }
  }

  return processed.slice(0, maxResults);
}
