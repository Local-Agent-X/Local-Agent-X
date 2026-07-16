/**
 * Ollama leg of llm-dispatch: which local model to use, and how to call it.
 *
 * Split out of llm-dispatch.ts (400-LOC gate). Cohesive on its own — every
 * other dispatch provider names its model from the canonical registry, while
 * Ollama's model set is whatever this particular machine has pulled, so the
 * "which model?" question is real work here and a one-liner everywhere else.
 *
 * Single-shot /api/generate only. Chat traffic does NOT come through here —
 * it rides the canonical OpenAI-compat adapter against /v1.
 */
import { createLogger } from "../logger.js";
import { getRuntimeConfig } from "../config.js";
import { getLocalRuntimes, refreshLocalRuntimes } from "../local-runtimes/index.js";
import { isEmbeddingModel } from "../canonical-loop/public/op-facts.js";

// Same channel name as llm-dispatch.ts: these lines were emitted under
// "[llm-dispatch]" before the split and callers grep for them.
const logger = createLogger("llm-dispatch");

/**
 * Pick an Ollama model that is ACTUALLY INSTALLED for a background dispatch.
 *
 * There is no safe hardcoded default. A pinned id ("llama3:8b") is only ever
 * correct for whoever happened to have pulled it: it silently 404s
 * /api/generate on every other box, and callers see a null they read as "LLM
 * unavailable". That default sat in llm-dispatch from April 2026 and became
 * wrong the day this box's model inventory changed — nothing in the code
 * moved, the machine did. The local-runtimes seam already knows what's
 * installed, so ask it rather than guessing, and return null (honest degrade,
 * no wire call) when the answer is "nothing chat-capable".
 *
 * Smallest-first: these are single-shot classifier/extraction prompts where
 * latency dominates and a 27B answers as well as a 120B. sizeBytes is the only
 * size signal the seam carries and it orders correctly on disk footprint.
 */
export async function resolveOllamaDispatchModel(): Promise<string | null> {
  if (getLocalRuntimes() === null) {
    // Boot race: cache never populated. One awaited sweep (coalesced), same
    // shape as the chat adapter's resolve-target.
    try { await refreshLocalRuntimes(); } catch { /* fall through to null */ }
  }
  const configured = getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
  const runtimes = getLocalRuntimes() ?? [];
  const rt =
    runtimes.find(r => r.kind === "ollama" && r.endpoint.baseUrl.replace(/\/+$/, "") === configured)
    ?? runtimes.find(r => r.kind === "ollama");
  if (!rt) return null;
  // isEmbeddingModel is the name-regex backstop for Ollama builds whose
  // /api/tags predates per-model capabilities; 0.32+ already dropped embedders
  // in the probe.
  const usable = rt.models
    .filter(m => !isEmbeddingModel(m.id))
    .sort((a, b) => (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.sizeBytes ?? Number.MAX_SAFE_INTEGER));
  return usable[0]?.id ?? null;
}

export async function callOllama(
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const base = getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature, num_predict: maxTokens } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`ollama call failed: HTTP ${res.status} (model=${model})`);
      return null;
    }
    const data = await res.json() as { response?: string };
    return data.response || null;
  } catch (e) {
    // Callers fall back to the next provider on null — without the warn
    // the user sees "all providers returned null" with zero context on
    // which one failed and why (timeout vs. network vs. JSON parse).
    logger.warn(`ollama call threw: ${(e as Error).message}`);
    return null;
  }
}
