/**
 * Window-aware output cap for LOCAL endpoints — completes the max_tokens
 * guard rail.
 *
 * The OpenAI-http transport applies LOCAL_DEFAULT_MAX_TOKENS (16384) to any
 * local endpoint whose caller didn't cap output. That default assumes the
 * window can afford it. vLLM-class engines VALIDATE prompt + max_tokens
 * against max_model_len and 400 the whole request otherwise — and a
 * completion-budget overflow is unrecoverable downstream: the value-400
 * (correctly) never latches the learned param store, and history compaction
 * cannot shrink a cap. On a small-window model the untouched default would
 * fail EVERY turn. (Ollama / LM Studio / llama.cpp clamp server-side instead
 * of validating, which is why the default alone was safe on those engines.)
 *
 * So the ONE seam that knows the measured window — the openai-compat
 * request-fit preflight — clamps the would-be cap DOWN to the completion
 * budget the window actually has:
 *
 *   cloud endpoint            → pass the explicit cap through untouched;
 *                               never invent one (guard rail, not style cap)
 *   window is a guess         → change nothing. "floor" is the unloaded-model
 *   ("floor" / "heuristic")     placeholder and "heuristic" a name-pattern
 *                               guess; acting on a guess is this preflight's
 *                               documented anti-pattern. The engine's own
 *                               server-side clamp covers the gap until a
 *                               probe sweep learns the real window.
 *   measured (probed / exact) → cap = min(explicit ?? default,
 *                               window − promptEstimate − OUTPUT_RESERVE);
 *                               if that budget is under
 *                               MIN_USEFUL_COMPLETION_TOKENS, send NO cap at
 *                               all (omitDefault): the prompt already ~fills
 *                               the window — prompt-side pressure is the
 *                               preflight/compaction's job, and a stub cap
 *                               would truncate replies into fragments.
 *
 * An explicit caller cap is never RAISED — only clamped by the same rule.
 */
import { LOCAL_DEFAULT_MAX_TOKENS } from "../../../providers/adapter/types.js";
import { OUTPUT_RESERVE_TOKENS, type RequestFit } from "../../../context-manager/request-fit.js";
import type { ContextWindowResolution } from "../../../context-manager/model-windows.js";
import { isLoopbackOrPrivateUrl } from "../../../local-only-policy.js";

/** Below this completion budget, omit max_tokens instead of sending a stub cap. */
export const MIN_USEFUL_COMPLETION_TOKENS = 256;

export interface LocalCapDecision {
  /** Cap to place on ProviderRequest.maxTokens; undefined = no explicit cap. */
  maxTokens: number | undefined;
  /** True → also set ProviderRequest.omitDefaultMaxTokens so the transport
   *  skips its local default for this request. */
  omitDefault: boolean;
}

/** Pure clamp core — see module header for the policy table. */
export function clampLocalMaxTokens(args: {
  isLocalEndpoint: boolean;
  /** The caller's cap (adapter opts), if any. */
  explicitMaxTokens: number | undefined;
  windowTokens: number;
  windowProvenance: ContextWindowResolution["provenance"];
  /** Estimated tokens of the request as it will actually ship. */
  promptTokensEstimate: number;
}): LocalCapDecision {
  const passthrough: LocalCapDecision = { maxTokens: args.explicitMaxTokens, omitDefault: false };
  if (!args.isLocalEndpoint) return passthrough;
  if (args.windowProvenance !== "probed" && args.windowProvenance !== "exact") return passthrough;

  const available = args.windowTokens - args.promptTokensEstimate - OUTPUT_RESERVE_TOKENS;
  if (available < MIN_USEFUL_COMPLETION_TOKENS) return { maxTokens: undefined, omitDefault: true };
  return { maxTokens: Math.min(args.explicitMaxTokens ?? LOCAL_DEFAULT_MAX_TOKENS, available), omitDefault: false };
}

/**
 * Seam-level wrapper for openai-compat's runTurn: derives endpoint locality
 * from the baseURL and the shipped prompt size from the preflight fit —
 * when the preflight stripped tools for this turn (fits_without_tools), the
 * tool manifest is NOT in the outbound request and must not eat the budget.
 */
export function resolveLocalCap(args: {
  baseURL: string | undefined;
  explicitMaxTokens: number | undefined;
  window: ContextWindowResolution;
  fit: RequestFit;
}): LocalCapDecision {
  return clampLocalMaxTokens({
    isLocalEndpoint: !!args.baseURL && isLoopbackOrPrivateUrl(args.baseURL),
    explicitMaxTokens: args.explicitMaxTokens,
    windowTokens: args.window.tokens,
    windowProvenance: args.window.provenance,
    promptTokensEstimate:
      args.fit.verdict === "fits_without_tools"
        ? args.fit.requestTokens - args.fit.toolTokens
        : args.fit.requestTokens,
  });
}
