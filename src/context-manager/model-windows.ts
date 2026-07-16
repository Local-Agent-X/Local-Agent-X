import { getLocalModel, getRuntimeForModel } from "../local-runtimes/index.js";

const MODEL_CONTEXTS: Record<string, number> = {
  // GPT-5.6 family (Sol/Terra/Luna) — 1.05M native, 128k max output
  "gpt-5.6": 1_000_000,      // bare alias routes to Sol
  "gpt-5.6-sol": 1_000_000,
  "gpt-5.6-terra": 1_000_000,
  "gpt-5.6-luna": 1_000_000,
  "gpt-5.4": 272_000,        // Native 1.05M, default working 272k
  "gpt-5.4-mini": 272_000,
  "gpt-5.5": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o3-pro": 128_000,
  // xAI Grok 4.x — 131k window (grok-4.5 ships a 500k window)
  "grok-4.5": 500_000,
  "grok-4.3": 131_072,
  "grok-4.20-0309-reasoning": 131_072,
  "grok-4.20-0309-non-reasoning": 131_072,
  "grok-4.20-multi-agent-0309": 131_072,
  "grok-code-fast-1": 131_072,
  "grok-build-0.1": 131_072,
  // Fable 5 — 1M context (native; the maximum is also the default)
  "claude-fable-5": 1_000_000,
  // Sonnet 5 — Claude 5 balanced tier, 1M context
  "claude-sonnet-5": 1_000_000,
  // Anthropic Claude 4.x family — 200k base window
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-7": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 1_000_000, // 4.7 ships with 1M context natively
  "claude-opus-4-8": 1_000_000, // 4.8 ships with 1M context natively
  "claude-haiku-4-5": 200_000,
  // Anthropic Opus 4.6 with 1M context beta
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-8[1m]": 1_000_000,
  // Gemini 2.x family (GA aliases)
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  // Gemini 3.x previews — 1M context
  "gemini-3-pro-preview": 1_000_000,
  "gemini-3.1-pro-preview": 1_000_000,
};

export const DEFAULT_CONTEXT = 128_000;

/**
 * Floor for a model a local runtime serves but whose window it wouldn't
 * report (not loaded yet, no Modelfile num_ctx). Deliberately small:
 * over-compaction is graceful and self-corrects on the next 60s sweep
 * once the model loads; the old 128k assumption OVERFLOWED for real
 * (measured 2026-07-15: LAX sent a 35,892-token turn to an LM Studio
 * model serving 8,192 — hard exceed_context_size_error).
 */
export const LOCAL_UNKNOWN_CONTEXT = 8_192;

/**
 * Where a window number came from. The distinction is load-bearing, not
 * informational: "probed" is a MEASUREMENT of what the runtime is serving,
 * "floor" is a GUESS standing in for a model that hasn't loaded yet. They
 * can be the same integer (a real 8,192-ctx LM Studio gemma vs. an unloaded
 * qwen3.6 that actually serves 262,144), so a caller holding only the number
 * cannot tell a fact from a placeholder.
 *
 * Callers that merely SIZE things (compaction) may treat every provenance
 * alike — over-compacting on a guess is graceful and self-corrects. Callers
 * that REFUSE work must gate on provenance: refusing on a guess is terminal
 * and cannot self-correct, because the refused request is the one that would
 * have loaded the model and revealed the truth. See openai-compat's preflight.
 */
export type ContextWindowProvenance =
  | "exact"      // hit in the pinned MODEL_CONTEXTS table
  | "probed"     // measured from a live local runtime — ground truth
  | "floor"      // local model, window unknowable right now — a GUESS
  | "heuristic"; // name-pattern / DEFAULT_CONTEXT — also a guess, cloud-side

export interface ContextWindowResolution {
  tokens: number;
  provenance: ContextWindowProvenance;
}

/**
 * Resolve a model's window AND how much to trust it. Prefer this over
 * lookupContextWindow anywhere the answer drives a refusal or an error.
 */
export function resolveContextWindow(model: string): ContextWindowResolution {
  if (MODEL_CONTEXTS[model]) return { tokens: MODEL_CONTEXTS[model], provenance: "exact" };
  // A model served by a DISCOVERED local runtime reports its REAL window
  // (src/local-runtimes/ probes: Ollama /api/ps num_ctx, LM Studio loaded
  // context, vLLM max_model_len, llama.cpp n_ctx). Ground truth beats the
  // name heuristics below — a local "llama3" is not a cloud family member.
  const rt = getRuntimeForModel(model);
  if (rt) {
    const probed = getLocalModel(rt.chatBaseUrl, model)?.contextWindow;
    return probed != null
      ? { tokens: probed, provenance: "probed" }
      : { tokens: LOCAL_UNKNOWN_CONTEXT, provenance: "floor" };
  }
  const lower = model.toLowerCase();
  const heuristic = (tokens: number): ContextWindowResolution => ({ tokens, provenance: "heuristic" });
  if (lower.includes("claude")) return heuristic(200_000);
  if (lower.includes("gemini")) return heuristic(1_000_000);
  if (lower.includes("gpt-5.6") || lower.includes("gpt-5.5")) return heuristic(1_000_000);
  if (lower.includes("gpt-5.4")) return heuristic(272_000);
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3")) return heuristic(128_000);
  if (lower.includes("grok")) return heuristic(131_072);
  return heuristic(DEFAULT_CONTEXT);
}

/** Window only. Fine for sizing/compaction; see resolveContextWindow to refuse. */
export function lookupContextWindow(model: string): number {
  return resolveContextWindow(model).tokens;
}

/**
 * Codex models (OpenAI gpt-5.x family) have a NOMINAL context window of up
 * to 1M tokens, but their PRACTICAL agentic performance degrades well before
 * that. We saw a 334k-token Codex turn end with "I'm missing the actual task
 * context" despite making real edits — the original task was buried under
 * tool results. Compact much earlier for Codex regardless of the nominal
 * window so the original user message stays anchored near the response
 * position. Anthropic models hold focus better and don't need this.
 */
export function isCodexModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith("gpt-") || lower.includes("codex") || lower.startsWith("o1") || lower.startsWith("o3");
}
