/**
 * The model's own reasoning, kept on its assistant row and sent back to it on
 * the next step of the same tool loop.
 *
 * A hosted provider hands its reasoning back as an opaque payload only it can
 * read: Codex an encrypted reasoning item, Anthropic signed thinking blocks,
 * Gemini a thought signature. Sent back, the model continues from what it
 * already worked out; dropped, it starts each tool step from the visible text
 * alone. Grok's Chat Completions API takes nothing back, and local models
 * replay plain text through their profile (`replayReasoning`), so neither
 * stores a payload here.
 *
 * Kept on `content.reasoningPayload` beside the readable `content.reasoning`
 * text: the two are different things (one is shown, one is a provider token),
 * and only the payload is provider-bound. Session history never carries it
 * (chat-runner/message-convert.ts copies an assistant row's text and tool
 * calls only), so a chat that switches provider cannot send one provider's
 * payload to another; `replayableReasoning` checks the origin regardless.
 */
import type { CanonicalMessage } from "../contract-types.js";

export type ReasoningProvider = "anthropic" | "codex" | "gemini";

export interface ReasoningPayload {
  provider: ReasoningProvider;
  model: string;
  /** The provider's own reasoning objects, exactly as it returned them. */
  data: unknown;
}

/** A payload larger than this is not kept: a step that reasoned that much is
 *  better re-derived than re-sent at full price on every later step. */
export const MAX_REASONING_PAYLOAD_BYTES = 64 * 1024;

/** The payload to store on an assistant row, or undefined when there is
 *  nothing to keep or it is over the cap. */
export function reasoningPayload(provider: ReasoningProvider, model: string, data: unknown): ReasoningPayload | undefined {
  if (data === undefined || data === null || (Array.isArray(data) && data.length === 0)) return undefined;
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_REASONING_PAYLOAD_BYTES) return undefined;
  return { provider, model, data };
}

/**
 * The assistant rows whose reasoning goes back to the model, by messageId:
 * rows of the current tool loop (after the last user row the model was
 * answering, not counting the trailing per-step rows the loop rebuilds every
 * step) whose payload came from this provider and this model. Earlier turns'
 * reasoning is not replayed: providers ignore or strip it, and it would be
 * paid for on every step.
 */
export function replayableReasoning(
  messages: readonly CanonicalMessage[],
  provider: ReasoningProvider,
  model: string,
  ephemeralTailMessages = 0,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const settled = messages.length - Math.max(0, ephemeralTailMessages);
  let loopStart = 0;
  for (let i = 0; i < settled; i++) if (messages[i].role === "user") loopStart = i + 1;
  for (let i = loopStart; i < settled; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const p = payloadOf(m);
    if (p && p.provider === provider && p.model === model) out.set(m.messageId, p.data);
  }
  return out;
}

function payloadOf(m: CanonicalMessage): ReasoningPayload | null {
  const c = m.content as { reasoningPayload?: unknown } | null | undefined;
  const p = c && typeof c === "object" ? c.reasoningPayload : undefined;
  if (!p || typeof p !== "object") return null;
  const { provider, model, data } = p as Partial<ReasoningPayload>;
  return typeof provider === "string" && typeof model === "string" && data !== undefined ? { provider: provider as ReasoningProvider, model, data } : null;
}
