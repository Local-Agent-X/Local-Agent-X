/**
 * HyDE — Hypothetical Document Embedding.
 *
 * The embedding model is trained to match DOCUMENTS to QUERIES, but the embedding
 * space itself is usually tuned to document-style text. Embedding a short
 * question and comparing it to long passages can miss matches that a
 * hypothetical-answer embedding would catch.
 *
 * Flow:
 *   1. Ask an LLM to write a plausible 1-3 sentence answer to the query
 *   2. Embed that hypothetical answer
 *   3. Use the HyDE embedding for vector search (BM25 still uses the literal query)
 *   4. Results blend keyword-precision with embedding-in-doc-space
 *
 * Skips:
 *   - Very short queries (< 4 words) — HyDE helps open-ended questions, not lookups
 *   - Trivial exact-match queries (quoted strings, single identifiers)
 *   - Cached previously-generated hypotheticals (same query → same doc)
 */
import { dispatch } from "../llm-dispatch.js";

export interface HyDEOptions {
  provider?: "ollama" | "anthropic" | "openai" | "auto";
  model?: string;
  timeoutMs?: number;
  cacheSize?: number;
}

// In-memory LRU cache (query → hypothetical). Survives within one process.
const cache = new Map<string, string>();
const DEFAULT_CACHE_SIZE = 500;

/**
 * Generate a hypothetical answer for the query. Returns null if HyDE should be
 * skipped (trivial query, no LLM available, or LLM timeout).
 */
export async function generateHyDE(query: string, opts: HyDEOptions = {}): Promise<string | null> {
  if (!shouldApplyHyDE(query)) return null;
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const prompt = buildPrompt(query);
  const raw = await dispatch({
    prompt,
    provider: opts.provider,
    ollamaModel: opts.model,
    anthropicModel: opts.model,
    openaiModel: opts.model,
    temperature: 0.3,
    maxTokens: 150,
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  if (!raw) return null;

  const cleaned = cleanResponse(raw);
  if (!cleaned) return null;

  // LRU-style cache
  if (cache.size >= (opts.cacheSize ?? DEFAULT_CACHE_SIZE)) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, cleaned);

  return cleaned;
}

/** Heuristic: when HyDE is worth the LLM call. */
function shouldApplyHyDE(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 15) return false;           // too short — just use literal
  const words = trimmed.split(/\s+/);
  if (words.length < 4) return false;              // keyword-style lookup
  if (/^["'].*["']$/.test(trimmed)) return false;  // quoted exact string
  if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(trimmed)) return false; // single identifier
  return true;
}

function buildPrompt(query: string): string {
  return `Write 1-3 sentences that would plausibly answer this question. Use concrete details even if you have to invent them — we want a realistic-sounding passage, not a list of possibilities.

QUESTION: ${query}

Rules:
- Do NOT hedge ("it might be", "could be") — write as if stating fact
- Include specific names, numbers, dates, or entities when natural
- Match the style of a diary/chat entry, not an essay
- Output only the answer. No preamble, no bullet points, no labels.

Answer:`;
}

function cleanResponse(raw: string): string {
  let text = raw.trim();
  // Strip common preamble patterns LLMs slip in despite instructions
  text = text.replace(/^(answer|response|reply)\s*[:\-]\s*/i, "");
  text = text.replace(/^["'`]+|["'`]+$/g, "");
  // Collapse blank lines
  text = text.replace(/\n{2,}/g, " ").replace(/\s+/g, " ").trim();
  // Sanity cap — HyDE docs should be short
  if (text.length > 600) text = text.slice(0, 600);
  if (text.length < 10) return "";
  return text;
}

/** Clear the cache — exported for tests and manual cache busts. */
export function clearHyDECache(): void { cache.clear(); }
export function hydeCacheSize(): number { return cache.size; }
