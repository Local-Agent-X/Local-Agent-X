import { getLocalModel, getRuntimeForModel } from "../local-runtimes/index.js";

// Nominal context window per model id — the number the provider rates the
// model at. Every row is rechecked against LiteLLM's model file by
// `npm run check:pricing-coverage` (scripts/model-windows-drift.mjs): a row
// that differs is DRIFT (red in the weekly CI job) unless its line comment
// carries `pin:` with the provider's own documented figure and the date it was
// read — LiteLLM is a mirror, the provider's docs are the truth. The app never
// fetches windows at runtime; a row changes only through a reviewed commit.
//
// One convention note: LiteLLM's max_input_tokens is sometimes the total
// window and sometimes the total minus the output cap (gpt-5.6: 922,000 =
// 1,050,000 − 128,000; gpt-5.4: 1,050,000). The checker accepts either.
const MODEL_CONTEXTS: Record<string, number> = {
  // OpenAI — developers.openai.com/api/docs/models, read 2026-09-27: the
  // gpt-6 / gpt-5.6 / gpt-5.4 pages all say "1,050,000 context window,
  // 128,000 max output tokens"; o3-pro "200,000 / 100,000".
  "gpt-6-astra": 1_050_000,
  "gpt-5.6": 1_050_000,      // bare alias routes to Sol
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.5": 1_050_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o3-pro": 200_000,
  // xAI — docs.x.ai/docs/models, read 2026-09-27: grok-4.6 500k;
  // grok-4.5 / 4.3 / 4.20 1M; grok-build-0.1 256k (grok-code-fast-1 is its
  // alias, 256k on its own page).
  "grok-4.6": 500_000,
  "grok-4.5": 1_000_000, // pin: x.ai docs 2026-09-27 say 1M; LiteLLM carries 500k
  "grok-4.3": 1_000_000,
  "grok-4.20-0309-reasoning": 1_000_000,
  "grok-4.20-0309-non-reasoning": 1_000_000,
  "grok-4.20-multi-agent-0309": 1_000_000,
  "grok-code-fast-1": 256_000,
  "grok-build-0.1": 256_000,
  // Anthropic — the Models API / model catalog rates every model from Opus 4.6
  // and Sonnet 4.6 on at 1M (LiteLLM agrees). Opus 4.5, Sonnet 4.5 and Haiku
  // 4.5 are 200k: Sonnet 4.5's 1M was a beta-header feature LAX never sends.
  "claude-opus-5-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "claude-mythos-5-1": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 200_000, // pin: 1M on Sonnet 4.5 needs the context-1m beta header, which LAX does not send
  "claude-opus-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  // `[1m]` aliases predate the 1M default and resolve to the same ids.
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-8[1m]": 1_000_000,
  "claude-opus-5[1m]": 1_000_000,
  "claude-opus-5-5[1m]": 1_000_000,
  // Gemini — ai.google.dev model pages, read 2026-09-27: "Input token limit
  // 1,048,576" for 2.5 Pro and 3.1 Pro Preview (LiteLLM: the same figure).
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-3-pro-preview": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
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
  // Family guesses for an id the table lacks (a model newer than this file).
  // Each is the SMALLEST current member of its family, so an unknown model
  // compacts early rather than overflowing.
  if (lower.includes("claude")) return heuristic(200_000);
  if (lower.includes("gemini")) return heuristic(1_048_576);
  if (lower.includes("gpt-6") || lower.includes("gpt-5.6") || lower.includes("gpt-5.5")) return heuristic(1_050_000);
  if (lower.includes("gpt-5.4")) return heuristic(272_000);
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3")) return heuristic(128_000);
  if (lower.includes("grok")) return heuristic(256_000);
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
