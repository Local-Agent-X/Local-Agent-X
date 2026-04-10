/**
 * Memory Reranker — optional LLM-based reranking of search results.
 *
 * Takes the top N candidates from hybrid search and asks a fast/cheap LLM
 * to score their relevance to the query. Improves multi-hop and temporal
 * questions at minimal cost.
 */

import type { MemorySearchResult } from "./memory.js";

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
  const topN = options.topN || 30;
  const candidates = results.slice(0, topN);
  if (candidates.length === 0) return results;

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
    console.warn("[reranker] LLM reranking failed, using original scores:", (e as Error).message);
  }
  return results;
}

async function callLLM(prompt: string, count: number, options: RerankOptions): Promise<number[]> {
  const provider = options.provider || "ollama";

  if (provider === "ollama") {
    const model = options.model || "llama3:8b";
    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 200 } }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        console.warn(`[reranker] Ollama returned ${res.status}`);
        return [];
      }
      const data = await res.json() as Record<string, unknown>;
      const response = String(data.response || "");
      if (!response) return [];
      return parseScores(response, count);
    } catch (e) {
      console.warn("[reranker] Ollama call failed:", (e as Error).message);
      return [];
    }
  }

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) return [];
    const model = options.model || "gpt-4o-mini";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, messages: [{ role: "user", content: prompt }],
          temperature: 0, max_tokens: 200,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return parseScores(data.choices?.[0]?.message?.content || "", count);
    } catch { return []; }
  }

  return [];
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
