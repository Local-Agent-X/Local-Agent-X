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
 * The tool manifest is FIXED overhead, exactly like the system prompt. There
 * is deliberately no "fits_without_tools" verdict: dropping the manifest
 * mid-turn silently changes the model's capabilities halfway through a tool
 * loop (incident 2026-09-08, muse-glimmer:30b — the model then hallucinated
 * tool calls as prose). Only history is negotiable, and shrinking it is
 * compaction's job (build-input.ts baseline). A request whose system + tools
 * + messages exceed the budget is too_big, full stop.
 *
 * Pure sizing math only. The caller supplies the window (from
 * lookupContextWindow — the single window authority) and acts on the
 * verdict:
 *   fits    → send as-is, tools intact
 *   too_big → don't send; surface a preflight error naming every component
 *             (system, tools, messages, window) so the user can raise the
 *             runtime's context length, pick a bigger-window model, or
 *             shrink the tool set
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

export type RequestFitVerdict = "fits" | "too_big";

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
  const requestTokens = systemTokens + toolTokens + messageTokens;
  const verdict: RequestFitVerdict = requestTokens <= budget ? "fits" : "too_big";

  return {
    verdict,
    windowTokens: args.windowTokens,
    requestTokens,
    systemTokens,
    toolTokens,
    messageTokens,
  };
}

/**
 * The user-facing preflight refusal for a too_big verdict. Replaces the
 * engine's raw 400 with every component's size and the actions that
 * actually fix it. Kept here so every adapter that adopts the preflight
 * says the same thing.
 */
export function describeUnfittableRequest(model: string, fit: RequestFit): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `Request needs ~${n(fit.requestTokens)} tokens but ${model} is running with a ${n(fit.windowTokens)}-token context window ` +
    `(${n(OUTPUT_RESERVE_TOKENS)} reserved for the response). ` +
    `Breakdown: system prompt ~${n(fit.systemTokens)}, tools ~${n(fit.toolTokens)}, messages ~${n(fit.messageTokens)}. ` +
    `Raise the model's context length in its runtime (e.g. the LM Studio context slider, Ollama num_ctx), ` +
    `switch to a larger-window model, or shrink the tool set.`
  );
}
