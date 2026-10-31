/**
 * The output cap (max_tokens / num_predict) for every openai-compat request —
 * the ONE place it is decided. The transports (providers/adapters/openai-http.ts,
 * ollama-native.ts) send ProviderRequest.maxTokens exactly as given; this seam
 * is the one that knows both the endpoint's locality and how much to trust the
 * window, so it decides alone:
 *
 *   cloud endpoint            → pass the explicit cap through untouched;
 *                               never invent one (guard rail, not style cap)
 *   local, window is a guess  → explicit cap, else LOCAL_DEFAULT_MAX_TOKENS.
 *   ("floor" / "declared" /     Unclamped: acting on a guess is this
 *    "heuristic")               preflight's documented anti-pattern, and the
 *                               engine's own server-side clamp covers the gap
 *                               until a probe sweep learns the real window.
 *   local, measured window    → cap = explicit, else LOCAL_DEFAULT_MAX_TOKENS,
 *   (probed / exact)            clamped to the budget: window − promptEstimate
 *                               − OUTPUT_RESERVE. If that budget is under
 *                               MIN_USEFUL_COMPLETION_TOKENS, send NO cap at
 *                               all: the prompt already ~fills the window —
 *                               prompt-side pressure is the preflight/
 *                               compaction's job, and a stub cap would
 *                               truncate replies into fragments.
 *
 * Why clamp at all: vLLM-class engines VALIDATE prompt + max_tokens against
 * max_model_len and 400 the whole request otherwise — and a completion-budget
 * overflow is unrecoverable downstream: the value-400 (correctly) never latches
 * the learned param store, and history compaction cannot shrink a cap. On a
 * small-window model a flat default would fail EVERY turn. (Ollama / LM Studio
 * / llama.cpp clamp server-side instead of validating, which is why the
 * default alone is safe on a guessed window.)
 *
 * An explicit caller cap is never RAISED — only clamped by the same rule.
 *
 * The flat default holds on a measured window too. A thinking model's
 * reasoning counts as output, and uncapped it runs away: with the cap lifted
 * (2026-10-27 to 10-30) qwen3.8 on Terminal-Bench 2.0 wrote 76 replies past
 * 16k tokens, one of 130,559, 5.3 hours of generation across the run, and the
 * tasks that produced them timed out (17 of 25) where the capped run of
 * 2026-10-24 had passed 7 of them. The degenerate-stream guard watches answer
 * text only, so nothing else bounds a silent stretch of thinking. What the cap
 * must NOT do is throw the thought away: a cut reply is continued from where
 * it stopped (cut-off-continuation.ts), so the cap is a bound on one silent
 * leg — about two minutes at local speed — not on the reply.
 */
import type { ProviderRequest } from "../../../providers/adapter/types.js";
import { OUTPUT_RESERVE_TOKENS, type RequestFit } from "../../../context-manager/request-fit.js";
import type { ContextWindowResolution } from "../../../context-manager/model-windows.js";
import { isLocalModelEndpoint } from "../../../local-runtimes/model-endpoint.js";

/**
 * Runaway guard rail for a LOCAL endpoint: a degenerate local model
 * (observed: a local Gemma looping one sentence verbatim for 41s until user
 * abort) can otherwise generate unbounded — the streaming path historically
 * sent NO token cap at all. Also the length of one continuation leg (above).
 */
export const LOCAL_DEFAULT_MAX_TOKENS = 16384;

/** Below this completion budget, send no max_tokens instead of a stub cap. */
export const MIN_USEFUL_COMPLETION_TOKENS = 256;

/** Pure decision core — see module header for the policy table. Returns the
 *  cap to send; undefined = no cap on the wire. */
export function clampLocalMaxTokens(args: {
  isLocalEndpoint: boolean;
  /** The caller's cap (adapter opts), if any. */
  explicitMaxTokens: number | undefined;
  windowTokens: number;
  windowProvenance: ContextWindowResolution["provenance"];
  /** Estimated tokens of the request as it will actually ship. */
  promptTokensEstimate: number;
}): number | undefined {
  if (!args.isLocalEndpoint) return args.explicitMaxTokens;
  if (args.windowProvenance !== "probed" && args.windowProvenance !== "exact") {
    return args.explicitMaxTokens ?? LOCAL_DEFAULT_MAX_TOKENS;
  }

  // The flat reserve on purpose, even for a thinking model: here it is slack
  // for the prompt estimate, and the cap itself IS the reply's budget —
  // subtracting output-reserve.ts's larger thinking reserve would shrink the
  // very budget that reserve exists to protect.
  const available = args.windowTokens - args.promptTokensEstimate - OUTPUT_RESERVE_TOKENS;
  if (available < MIN_USEFUL_COMPLETION_TOKENS) return undefined;
  return Math.min(args.explicitMaxTokens ?? LOCAL_DEFAULT_MAX_TOKENS, available);
}

/**
 * Seam-level wrapper for openai-compat's runTurn: derives endpoint locality
 * from the baseURL (loopback, private-range, or a runtime the operator added
 * by name — isLocalModelEndpoint) and the shipped prompt size from the
 * preflight fit. The request ships exactly as sized — tools are never
 * stripped by the preflight — so the full requestTokens estimate is the
 * budget the prompt consumes.
 */
export function resolveLocalCap(args: {
  baseURL: string | undefined;
  explicitMaxTokens: number | undefined;
  window: ContextWindowResolution;
  fit: RequestFit;
}): number | undefined {
  return clampLocalMaxTokens({
    isLocalEndpoint: isLocalModelEndpoint(args.baseURL),
    explicitMaxTokens: args.explicitMaxTokens,
    windowTokens: args.window.tokens,
    windowProvenance: args.window.provenance,
    promptTokensEstimate: args.fit.requestTokens,
  });
}

/** Put resolveLocalCap's decision on the request the transport sends. */
export function applyLocalCap(
  req: Pick<ProviderRequest, "maxTokens">,
  args: Parameters<typeof resolveLocalCap>[0],
): void {
  req.maxTokens = resolveLocalCap(args);
}
