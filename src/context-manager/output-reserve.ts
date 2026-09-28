/**
 * How many tokens of the window a request must leave for the model's reply.
 *
 * A flat OUTPUT_RESERVE_TOKENS (1,024) is right for a model that answers
 * directly, and for every cloud model, whose output budget is not carved out
 * of the same window LAX sizes. It is wrong for a LOCAL model that thinks
 * before it answers: the reasoning is generated into the same llama.cpp
 * context as the prompt, so a prompt that leaves 1,024 tokens starves the
 * reasoning and the reply truncates (finish "length") mid-thought.
 *
 * For a local model whose declared profile thinks, the reserve is 1/16 of the
 * window, clamped to 4,096..8,192 (never more than a quarter of the window):
 * 65,536 -> 4,096, 131,072 and up -> 8,192. Everything else keeps 1,024.
 * request-fit.ts stays the owner of the constant; this only chooses it.
 */
import { OUTPUT_RESERVE_TOKENS } from "./request-fit.js";
import { getRuntimeForModel } from "../local-runtimes/index.js";
import { modelThinking } from "../local-runtimes/model-profile.js";

export const THINKING_RESERVE_MIN_TOKENS = 4_096;
export const THINKING_RESERVE_MAX_TOKENS = 8_192;

export function thinkingOutputReserve(windowTokens: number): number {
  const share = Math.floor(windowTokens / 16);
  const clamped = Math.min(THINKING_RESERVE_MAX_TOKENS, Math.max(THINKING_RESERVE_MIN_TOKENS, share));
  return Math.max(OUTPUT_RESERVE_TOKENS, Math.min(clamped, Math.floor(windowTokens / 4)));
}

export function resolveOutputReserve(model: string, windowTokens: number): number {
  if (!getRuntimeForModel(model)) return OUTPUT_RESERVE_TOKENS;
  const thinking = modelThinking(model);
  if (!thinking?.supported || thinking.mode === "off") return OUTPUT_RESERVE_TOKENS;
  return thinkingOutputReserve(windowTokens);
}
