/**
 * Memory Reranker — optional LLM-based reranking of search results.
 *
 * Takes the top N candidates from hybrid search and asks a fast/cheap LLM
 * to score their relevance to the query. Improves multi-hop and temporal
 * questions at minimal cost.
 */

import type { MemorySearchResult } from "./index.js";

import { createLogger } from "../logger.js";
import { dispatch } from "../llm-dispatch.js";
const logger = createLogger("memory-reranker");

export interface RerankOptions {
  model?: string;
  topN?: number;       // how many candidates to rerank (default 30)
  provider?: string;   // "ollama" | "openai"
}

/**
 * Rerank search results using an LLM.
 * Returns re-scored results sorted by LLM relevance score.
 */
export async function rerankWithLLM(
  query: string,
  results: MemorySearchResult[],
  options: RerankOptions = {},
): Promise<MemorySearchResult[]> {
  const topN = options.topN || 50;
  const candidates = results.slice(0, topN);
  if (candidates.length === 0) return results;
  // Small delay to avoid rate limiting on API providers
  if (options.provider === "anthropic" || options.provider === "openai") {
    await new Promise(r => setTimeout(r, 200));
  }

  const numbered = candidates.map((r, i) =>
    `[${i + 1}] ${r.snippet.slice(0, 250).replace(/\n/g, " ")}`
  ).join("\n");

  const prompt = `Given this question: "${query}"

Rate each passage's relevance from 0 (irrelevant) to 10 (directly answers the question).
Return ONLY a JSON array of numbers, nothing else. Example for 5 passages: [8, 2, 10, 0, 5]

${numbered}

JSON array of ${candidates.length} scores:`;

  try {
    const scores = await callLLM(prompt, candidates.length, options);
    if (scores.length === candidates.length) {
      for (let i = 0; i < candidates.length; i++) {
        candidates[i].score = (scores[i] / 10) * 0.8 + candidates[i].score * 0.2;
      }
      candidates.sort((a, b) => b.score - a.score);
      return [...candidates, ...results.slice(topN)];
    }
  } catch (e) {
    logger.warn("[reranker] LLM reranking failed, using original scores:", (e as Error).message);
  }
  return results;
}

/**
 * Every provider rides the canonical single-shot dispatcher (llm-dispatch), the
 * same seam memory-resolver/memory-extract/memory-hyde use. Each leg here used
 * to raw-fetch its provider and drifted from it: the Anthropic one Bearer-sent
 * subscription credentials (the banned direct-HTTP path) and sent temperature
 * to adaptive models (a 400); the Ollama one sent no num_ctx, so a rerank at a
 * different context size reloaded the chat model under the next chat turn, and
 * defaulted to qwen2:7b rather than the background model every other local
 * side call uses. A failure returns [] (original scores kept, warned), never a
 * fallback to another provider. 200 tokens, temperature 0; Ollama keeps its
 * longer 60 s timeout for a cold load.
 */
async function callLLM(prompt: string, count: number, options: RerankOptions): Promise<number[]> {
  const provider = options.provider || "ollama";
  const model =
    provider === "ollama" ? { ollamaModel: options.model }
      : provider === "anthropic" ? { anthropicModel: options.model }
        : provider === "openai" ? { openaiModel: options.model }
          : null;
  if (!model) return [];
  const text = await dispatch({
    prompt, provider: provider as "ollama" | "anthropic" | "openai", ...model,
    temperature: 0, maxTokens: 200, timeoutMs: provider === "ollama" ? 60_000 : 30_000,
  });
  if (text === null) { logger.warn(`[reranker] ${provider} dispatch failed`); return []; }
  const scores = parseScores(text, count);
  if (scores.length > 0) logger.info(`[reranker] ${provider} scored ${scores.length} candidates`);
  else logger.warn(`[reranker] ${provider} returned unparseable: ${text.slice(0, 80)}`);
  return scores;
}

function parseScores(text: string, expectedCount: number): number[] {
  // Strip markdown code blocks
  const cleaned = text.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();

  // Try to find a JSON array anywhere in the response
  // Match arrays with numbers, allowing decimals, spaces, newlines
  const arrayMatch = cleaned.match(/\[\s*[\d][\d\s,.\n]*\]/);
  if (!arrayMatch) {
    // Fallback: try to extract comma-separated numbers
    const numMatch = cleaned.match(/(\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*)/);
    if (numMatch) {
      const nums = numMatch[1].split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
      if (nums.length === expectedCount && nums.every(n => n >= 0 && n <= 10)) return nums;
    }
    return [];
  }

  try {
    // Normalize: remove newlines inside array, fix spacing
    const normalized = arrayMatch[0].replace(/\n/g, " ").replace(/\s+/g, " ");
    const scores = JSON.parse(normalized) as number[];
    if (scores.length === expectedCount && scores.every(n => typeof n === "number" && n >= 0 && n <= 10)) {
      return scores;
    }
    // If count doesn't match exactly, try truncating or padding
    if (scores.length > expectedCount) return scores.slice(0, expectedCount);
  } catch {}

  return [];
}
