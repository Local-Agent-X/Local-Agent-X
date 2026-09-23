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
import { dispatchNumCtx, MODEL_KEEP_ALIVE } from "../local-runtimes/residency.js";
import { isEmbeddingModel } from "../canonical-loop/public/op-facts.js";
import { awaitForegroundModelIdle } from "./foreground-model-lease.js";

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

/** Disk size of `model` from the discovery cache; undefined when not discovered.
 *
 *  Never throws: the size only SHARPENS the dispatch context choice (a model
 *  above the dispatch cap keeps its own window), so an unavailable registry must
 *  degrade to "unknown", not fail the call it was sizing. It threw once, when a
 *  caller's runtime registry wasn't loaded, and took the whole background
 *  dispatch down with it. */
export function localModelSizeBytes(model: string): number | undefined {
  const tagged = (id: string) => (id.includes(":") ? id : `${id}:latest`);
  try {
    return getLocalRuntimes()
      ?.flatMap((rt) => rt.models)
      .find((m) => tagged(m.id) === tagged(model))?.sizeBytes;
  } catch {
    return undefined;
  }
}

interface OllamaGenerateResponse {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  load_duration?: number;
}

export interface OllamaUsage {
  promptEvalCount: number;
  evalCount: number;
  promptEvalMs: number;
  evalMs: number;
  loadMs: number;
  /** A resident model reports a load of single-digit milliseconds; anything
   *  past a second means the runner was (re)started for this call. */
  reloaded: boolean;
}

const RELOAD_THRESHOLD_MS = 1_000;

/** Ollama's per-request counters (nanoseconds on the wire), or null when the
 *  response carries none. */
export function summarizeOllamaUsage(data: OllamaGenerateResponse): OllamaUsage | null {
  if (typeof data.prompt_eval_count !== "number" && typeof data.eval_count !== "number") return null;
  const ms = (ns?: number) => Math.round((ns ?? 0) / 1e6);
  const loadMs = ms(data.load_duration);
  return {
    promptEvalCount: data.prompt_eval_count ?? 0,
    evalCount: data.eval_count ?? 0,
    promptEvalMs: ms(data.prompt_eval_duration),
    evalMs: ms(data.eval_duration),
    loadMs,
    reloaded: loadMs > RELOAD_THRESHOLD_MS,
  };
}

export async function callOllama(
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
  exactBaseUrl?: string,
  think?: boolean,
): Promise<string | null> {
  try {
    // A side call on the model a chat op is driving waits for that op to
    // finish (foreground-model-lease.ts): landing between two of its rounds
    // would cost the op its whole prompt cache. The op's own calls pass through.
    await awaitForegroundModelIdle(model);
    const base = (exactBaseUrl ?? getRuntimeConfig().ollamaUrl).replace(/\/+$/, "");
    // Never a fixed size: a num_ctx different from the loaded runner makes
    // Ollama reload the model, and when this dispatch targets the chat model
    // that shrinks the window the chat turn is sized against (residency.ts).
    const numCtx = await dispatchNumCtx(
      base, model, localModelSizeBytes(model), Math.min(2_000, Math.max(250, Math.floor(timeoutMs / 4))),
      exactBaseUrl ? "manual" : undefined,
    );
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // keep_alive holds the model in memory past Ollama's 5m default. The
      // first call after idle pays the full cold load INSIDE the caller's
      // timeout (16.5s observed 2026-07 — the classifier's whole wallclock),
      // so every keep-alive we skip converts a future fast call into a
      // timeout. Same knob the residency warm path uses.
      body: JSON.stringify({
        model, prompt, stream: false, keep_alive: MODEL_KEEP_ALIVE,
        ...(think !== undefined ? { think } : {}),
        options: { temperature, num_predict: maxTokens, ...(numCtx !== undefined ? { num_ctx: numCtx } : {}) },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      ...(exactBaseUrl ? { redirect: "manual" as const } : {}),
    });
    if (!res.ok) {
      logger.warn(`ollama call failed: HTTP ${res.status} (model=${model})`);
      return null;
    }
    const data = await res.json() as OllamaGenerateResponse;
    const usage = summarizeOllamaUsage(data);
    if (usage) {
      const ctx = numCtx !== undefined ? ` num_ctx=${numCtx}` : "";
      logger.info(`[ollama] usage model=${model} prompt_eval=${usage.promptEvalCount} eval=${usage.evalCount} prompt_ms=${usage.promptEvalMs} eval_ms=${usage.evalMs} load_ms=${usage.loadMs}${ctx}`);
      // A load inside a dispatch call is the context-size ping-pong (or an
      // eviction): the model was just restarted at a different size, and the
      // next chat turn on it re-prefills its whole prompt. Say so where it
      // happens instead of leaving it to the next slow turn.
      if (usage.reloaded) {
        logger.warn(`[ollama] ${model} (re)loaded during a background dispatch (load_ms=${usage.loadMs}${ctx}) — a context-size mismatch or an eviction`);
      }
    }
    return data.response || null;
  } catch (e) {
    // Callers fall back to the next provider on null — without the warn
    // the user sees "all providers returned null" with zero context on
    // which one failed and why (timeout vs. network vs. JSON parse).
    logger.warn(`ollama call threw: ${(e as Error).message}`);
    return null;
  }
}
