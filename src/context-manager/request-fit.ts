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

/**
 * Share of a LOCAL model's window the system prompt may occupy. The prompt
 * degrader (context/prompt-degradation.ts) enforces it; the per-result cap
 * (tool-result-cap.ts) reserves the same share when sizing tool results, so
 * both sides of the window agree on one allocation.
 *
 * It used to sit behind an absolute gate (window > 32,768 and tier !==
 * "weak" => full prompt, no budget at all), which silently exempted every
 * 33k-128k local model: on 2026-09-08 a 65,536-token model was handed a
 * 36,978-token system prompt (56% of its window), the 23-tool medium manifest
 * took another ~13,600 (fixed overhead 77%), and the third tool step
 * overflowed. A relative budget only means something if it is applied
 * relatively.
 *
 * Why 0.35, sized on the 65,536 window that exposed the bug:
 *   budget            = floor(65,536 * 0.35)            = 22,937
 *   tool manifest     ~ 13,617 (medium tier, 23 tools, measured 2026-09-08)
 *   response reserve  =  1,024 (OUTPUT_RESERVE_TOKENS)
 *   left for messages = 65,536 - 22,937 - 13,617 - 1,024 = 27,958  (42.7%)
 * The floor we want is ~40% of the window for the conversation; the share
 * that hits exactly 40% on this model is (65,536 - 26,214 - 13,617 - 1,024)
 * / 65,536 = 0.377, so 0.35 clears it with margin and gets roomier as
 * windows grow (131,072: 51% left). Below ~48k the tool manifest, not this
 * share, is the dominant fixed cost (32k medium: 23% left) - that is the
 * tier picker's lever (maxToolsForTier), not a second knob here.
 */
export const PROMPT_WINDOW_SHARE = 0.35;

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
