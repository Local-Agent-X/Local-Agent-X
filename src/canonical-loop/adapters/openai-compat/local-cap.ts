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
 *   measured (probed / exact) → cap = min(explicit ?? default × 2^redrives,
 *                               window − promptEstimate − OUTPUT_RESERVE);
 *                               if that budget is under
 *                               MIN_USEFUL_COMPLETION_TOKENS, send NO cap at
 *                               all (omitDefault): the prompt already ~fills
 *                               the window — prompt-side pressure is the
 *                               preflight/compaction's job, and a stub cap
 *                               would truncate replies into fragments.
 *
 * An explicit caller cap is never RAISED — only clamped by the same rule.
 *
 * The default doubles for each cut-off re-drive in a row (TurnInput.
 * cutOffRedrives, turn-loop/cut-off-turn.ts): a thinking model's reasoning
 * counts against the cap, and a reply cut off before its first tool call
 * needs more room, not the same room again. Only on a measured window, where
 * the doubled cap can be held to what the window has left.
 */
import { LOCAL_DEFAULT_MAX_TOKENS, type ProviderRequest } from "../../../providers/adapter/types.js";
import { OUTPUT_RESERVE_TOKENS, type RequestFit } from "../../../context-manager/request-fit.js";
import type { ContextWindowResolution } from "../../../context-manager/model-windows.js";
import { isLocalModelEndpoint } from "../../../local-runtimes/model-endpoint.js";

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
  /** Cut-off re-drives in a row this request follows (absent = 0). */
  cutOffRedrives?: number;
}): LocalCapDecision {
  const passthrough: LocalCapDecision = { maxTokens: args.explicitMaxTokens, omitDefault: false };
  if (!args.isLocalEndpoint) return passthrough;
  if (args.windowProvenance !== "probed" && args.windowProvenance !== "exact") return passthrough;

  // The flat reserve on purpose, even for a thinking model: here it is slack
  // for the prompt estimate, and the cap itself IS the reply's budget —
  // subtracting output-reserve.ts's larger thinking reserve would shrink the
  // very budget that reserve exists to protect.
  const available = args.windowTokens - args.promptTokensEstimate - OUTPUT_RESERVE_TOKENS;
  if (available < MIN_USEFUL_COMPLETION_TOKENS) return { maxTokens: undefined, omitDefault: true };
  const cap = args.explicitMaxTokens ?? LOCAL_DEFAULT_MAX_TOKENS * 2 ** (args.cutOffRedrives ?? 0);
  return { maxTokens: Math.min(cap, available), omitDefault: false };
}

/**
 * Seam-level wrapper for openai-compat's runTurn: derives endpoint locality
 * from the baseURL and the shipped prompt size from the preflight fit. The
 * request ships exactly as sized — tools are never stripped by the preflight
 * — so the full requestTokens estimate is the budget the prompt consumes.
 */
export function resolveLocalCap(args: {
  baseURL: string | undefined;
  explicitMaxTokens: number | undefined;
  window: ContextWindowResolution;
  fit: RequestFit;
  cutOffRedrives?: number;
}): LocalCapDecision {
  return clampLocalMaxTokens({
    isLocalEndpoint: isLocalModelEndpoint(args.baseURL),
    explicitMaxTokens: args.explicitMaxTokens,
    windowTokens: args.window.tokens,
    windowProvenance: args.window.provenance,
    promptTokensEstimate: args.fit.requestTokens,
    cutOffRedrives: args.cutOffRedrives,
  });
}

/** Put resolveLocalCap's decision on the request the transport sends. */
export function applyLocalCap(
  req: Pick<ProviderRequest, "maxTokens" | "omitDefaultMaxTokens">,
  args: Parameters<typeof resolveLocalCap>[0],
): void {
  const cap = resolveLocalCap(args);
  req.maxTokens = cap.maxTokens;
  if (cap.omitDefault) req.omitDefaultMaxTokens = true;
}
