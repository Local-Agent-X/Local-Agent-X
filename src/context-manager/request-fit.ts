/**
 * Request-fit preflight — sizes the FULL outbound request (system prompt +
 * tool schemas + messages) against the model's context window BEFORE the
 * adapter sends it.
 *
 * Why this exists: compaction (compact-history.ts) can only shrink the
 * message array. On small-window local models the fixed overhead — system
 * prompt plus the tool manifest — can exceed the window by itself, so a
 * one-word first message dies with the engine's raw 400 (measured
 * 2026-07-15: a 36,611-token "hi" request into an LM Studio model loaded
 * with n_ctx 8,192 — exceed_context_size_error). No amount of history
 * compaction fixes a request whose baseline doesn't fit.
 *
 * Pure sizing math only. The caller supplies the window (from
 * lookupContextWindow — the single window authority) and acts on the
 * verdict:
 *   fits               → send as-is
 *   fits_without_tools → drop the tool manifest for this turn (a window
 *                        problem, NOT a capability problem — never latch
 *                        markNoToolSupport off the back of this verdict)
 *   too_big            → don't send; surface a preflight error naming the
 *                        numbers so the user can raise the runtime's
 *                        context length or pick a bigger-window model
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { estimateTokens, totalTokens } from "./token-estimation.js";

/**
 * Tokens reserved for the model's RESPONSE. llama.cpp-style engines share
 * one window between prompt and output, so a prompt that exactly fills
 * n_ctx still fails or truncates instantly. Also absorbs estimate error
 * (chars/3.5 is deliberately rough).
 */
export const OUTPUT_RESERVE_TOKENS = 1_024;

/** Per-tool serialization overhead beyond the JSON itself (wrapping keys,
 *  runtime chat-template framing). */
const PER_TOOL_OVERHEAD_TOKENS = 8;

export interface ToolDefLike {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type RequestFitVerdict = "fits" | "fits_without_tools" | "too_big";

export interface RequestFit {
  verdict: RequestFitVerdict;
  windowTokens: number;
  /** Estimate of the full request as composed: system + tools + messages. */
  requestTokens: number;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
}

/** Estimated tokens the serialized tool manifest adds to the request. */
export function toolManifestTokens(tools: ReadonlyArray<ToolDefLike>): number {
  let sum = 0;
  for (const t of tools) {
    sum += estimateTokens(JSON.stringify(t)) + PER_TOOL_OVERHEAD_TOKENS;
  }
  return sum;
}

/**
 * Size a composed request against a model window. Pure — the window comes
 * from the caller (lookupContextWindow) so this module never grows a second
 * window table.
 */
export function assessRequestFit(args: {
  windowTokens: number;
  systemPrompt: string;
  tools: ReadonlyArray<ToolDefLike>;
  messages: ChatCompletionMessageParam[];
}): RequestFit {
  const systemTokens = estimateTokens(args.systemPrompt);
  const toolTokens = toolManifestTokens(args.tools);
  const messageTokens = totalTokens(args.messages);
  const budget = args.windowTokens - OUTPUT_RESERVE_TOKENS;
  const withTools = systemTokens + toolTokens + messageTokens;
  const withoutTools = systemTokens + messageTokens;

  let verdict: RequestFitVerdict;
  if (withTools <= budget) verdict = "fits";
  else if (withoutTools <= budget) verdict = "fits_without_tools";
  else verdict = "too_big";

  return {
    verdict,
    windowTokens: args.windowTokens,
    requestTokens: withTools,
    systemTokens,
    toolTokens,
    messageTokens,
  };
}

/**
 * The user-facing preflight refusal for a too_big verdict. Replaces the
 * engine's raw 400 with the numbers and the two actions that actually fix
 * it. Kept here so every adapter that adopts the preflight says the same
 * thing.
 */
export function describeUnfittableRequest(model: string, fit: RequestFit): string {
  const req = fit.requestTokens.toLocaleString("en-US");
  const win = fit.windowTokens.toLocaleString("en-US");
  const base = fit.systemTokens + fit.toolTokens;
  return (
    `Request needs ~${req} tokens but ${model} is running with a ${win}-token context window. ` +
    `Fixed overhead (system prompt + tools) is ~${base.toLocaleString("en-US")} tokens, so this cannot fit even with tools dropped. ` +
    `Raise the model's context length in its runtime (e.g. the LM Studio context slider, Ollama num_ctx) or switch to a larger-window model.`
  );
}
