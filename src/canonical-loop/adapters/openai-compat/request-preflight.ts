/**
 * Request-fit preflight for the openai-compat adapter — the one seam that
 * sizes the composed request against the model's context window BEFORE it
 * ships. Extracted from openai-compat.ts's runTurn; the adapter acts on the
 * decision (report + return on "refuse", send on "send").
 *
 * The engine 400s (llama.cpp/LM Studio exceed_context_size_error) on a
 * request bigger than the model's LOADED context, and history compaction
 * can't save a request whose FIXED overhead (system prompt + tool manifest)
 * doesn't fit on its own — observed 2026-07-15: a 36,611-token "hi" into an
 * 8,192-ctx LM Studio gemma. Local runtimes report their true loaded window
 * via the src/local-runtimes/ probes, so size the composed request against it.
 *
 * Invariant: a tool loop never sends a step without the tools it started
 * with. There is no "strip the manifest and send anyway" degrade — dropping
 * tools mid-turn silently changes the model's capabilities halfway through a
 * tool loop (incident 2026-09-08, muse-glimmer:30b then hallucinated tool
 * calls as prose). If the request doesn't fit it is too_big and refused with
 * the numbers (describeUnfittableRequest), never quietly reshaped.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import {
  assessRequestFit,
  describeUnfittableRequest,
  type RequestFit,
  type ToolDefLike,
} from "../../../context-manager/request-fit.js";
import { resolveContextWindow, type ContextWindowResolution } from "../../../context-manager/model-windows.js";
import { createLogger } from "../../../logger.js";

const logger = createLogger("canonical-loop.adapters.openai-compat.preflight");

export type OpenAiCompatPreflight =
  | { kind: "send"; window: ContextWindowResolution; fit: RequestFit }
  | { kind: "refuse"; message: string; window: ContextWindowResolution; fit: RequestFit };

/** The slice of a ProviderRequest the preflight sizes — nothing else. */
export interface PreflightRequest {
  systemPrompt: string;
  tools: ReadonlyArray<ToolDefLike>;
  messages: ChatCompletionMessageParam[];
}

/**
 * Resolve the model's window, size `req` against it, and decide whether the
 * adapter may send. Never mutates `req`.
 */
export function assessOpenAiCompatPreflight(args: {
  model: string;
  req: PreflightRequest;
}): OpenAiCompatPreflight {
  const { model, req } = args;
  const window = resolveContextWindow(model);
  const fit = assessRequestFit({
    windowTokens: window.tokens,
    systemPrompt: req.systemPrompt,
    tools: req.tools,
    messages: req.messages,
  });
  // Only ACT on a window we actually measured. A "floor" window is the
  // placeholder for a local model that hasn't loaded yet (no /api/ps entry,
  // no Modelfile num_ctx) — it is not this model's window, it's a stand-in.
  // Refusing on it deadlocks: the refused send is the very request that
  // would load the model, populate /api/ps, and replace the guess with the
  // truth on the next 60s sweep. Regressed 2026-07-15 when this preflight
  // landed six hours after the floor and silently voided the floor's
  // "self-corrects once the model loads" premise — a 262,144-ctx qwen3.6
  // was refused all night against a phantom 8,192. Send it: an engine 400
  // is recoverable and self-correcting, a refusal loop is neither.
  if (window.provenance === "floor" && fit.verdict !== "fits") {
    logger.info(
      `${model}: window unknown (model not loaded yet) — the ${window.tokens}-token floor is a placeholder, not a measurement, so preflight is not refusing this send. The runtime will load the model and the next sweep learns its real window. Compaction still sizes history against the floor.`,
    );
    return { kind: "send", window, fit };
  }
  if (fit.verdict === "too_big") {
    const message = describeUnfittableRequest(model, fit);
    logger.warn(`preflight refused send: ${message}`);
    return { kind: "refuse", message, window, fit };
  }
  return { kind: "send", window, fit };
}
