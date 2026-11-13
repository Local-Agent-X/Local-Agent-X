/**
 * One Messages API SSE event → the client's StreamEvents, for the direct-HTTP
 * path (stream-api.ts). Owns the per-response state the frames build up: the
 * open tool call, the usage counts, the stop reason, and the response's
 * thinking blocks.
 *
 * Thinking blocks are kept whole — the summarized text, the signature, and a
 * redacted block's opaque `data` — so the next step of the same tool loop can
 * send them back unchanged (canonical-loop/adapters/row-reasoning.ts). Checked
 * live on the subscription (Opus 5.5, Fable 5.2, Sonnet 5.5; 2026-11-13): a
 * replayed block is accepted, also after the per-step digest before it
 * changed, and a block whose signature was altered is refused (400 "Invalid
 * `signature` in `thinking` block").
 */
import type { StreamEvent } from "./types.js";

/** A thinking or redacted_thinking block exactly as the API sent it. */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface SseState {
  toolId: string;
  toolName: string;
  toolArgs: string;
  inputTokens: number;
  outputTokens: number;
  // Cache fields stay undefined when the API doesn't report them — "absent"
  // and "0" are different downstream (context anchoring refuses absent).
  cacheReadTokens: number | undefined;
  cacheCreateTokens: number | undefined;
  stopReason: string | undefined;
  sawText: boolean;
  sawToolCall: boolean;
  responseText: string;
  thinkingBlocks: ThinkingBlock[];
  openThinking: ThinkingBlock | null;
}

export function newSseState(): SseState {
  return {
    toolId: "", toolName: "", toolArgs: "", inputTokens: 0, outputTokens: 0,
    cacheReadTokens: undefined, cacheCreateTokens: undefined, stopReason: undefined,
    sawText: false, sawToolCall: false, responseText: "", thinkingBlocks: [], openThinking: null,
  };
}

/** `toolName` maps a wire tool name back to the caller's (OAuth renames them). */
export function* sseEvents(parsed: Record<string, unknown>, s: SseState, toolName: (wire: string) => string): Generator<StreamEvent> {
  const eventType = parsed.type as string;
  if (eventType === "message_start") {
    const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number>;
    if (usage) {
      s.inputTokens = usage.input_tokens || 0;
      // input_tokens EXCLUDES the cached prefix; the cache read/write
      // counts arrive here. Without them the turn's recorded usage
      // undercounts context by the whole cached prefix (tools array +
      // prior turns) — the CLI path (stream-cli/stream-parse.ts)
      // already forwards both.
      if (typeof usage.cache_read_input_tokens === "number") s.cacheReadTokens = usage.cache_read_input_tokens;
      if (typeof usage.cache_creation_input_tokens === "number") s.cacheCreateTokens = usage.cache_creation_input_tokens;
    }
  } else if (eventType === "content_block_start") {
    const block = parsed.content_block as Record<string, unknown>;
    if (block?.type === "tool_use") {
      s.toolId = block.id as string;
      s.toolName = block.name as string;
      s.toolArgs = "";
    } else if (block?.type === "thinking") {
      s.openThinking = { type: "thinking", thinking: String(block.thinking ?? ""), signature: String(block.signature ?? "") };
    } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
      s.openThinking = { type: "redacted_thinking", data: block.data };
    }
  } else if (eventType === "content_block_delta") {
    const delta = parsed.delta as Record<string, unknown>;
    const open = s.openThinking?.type === "thinking" ? s.openThinking : null;
    if (delta?.type === "text_delta") { s.sawText = true; const t = delta.text as string; s.responseText += t; yield { type: "text", delta: t }; }
    // Extended-thinking summary deltas — reasoning, not answer text.
    else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      if (open) open.thinking += delta.thinking;
      yield { type: "thinking", delta: delta.thinking as string };
    }
    else if (delta?.type === "signature_delta" && typeof delta.signature === "string") { if (open) open.signature += delta.signature; }
    else if (delta?.type === "input_json_delta") s.toolArgs += delta.partial_json as string;
  } else if (eventType === "content_block_stop") {
    if (s.openThinking) {
      s.thinkingBlocks.push(s.openThinking);
      s.openThinking = null;
    } else if (s.toolId) {
      s.sawToolCall = true;
      yield { type: "tool_call", id: s.toolId, name: toolName(s.toolName), arguments: s.toolArgs };
      s.toolId = ""; s.toolName = ""; s.toolArgs = "";
    }
  } else if (eventType === "message_delta") {
    const usage = parsed.usage as Record<string, number>;
    if (usage) {
      s.outputTokens = usage.output_tokens || 0;
      // Some API versions restate cache counts on the final delta —
      // last-wins keeps whichever frame carried them.
      if (typeof usage.cache_read_input_tokens === "number") s.cacheReadTokens = usage.cache_read_input_tokens;
      if (typeof usage.cache_creation_input_tokens === "number") s.cacheCreateTokens = usage.cache_creation_input_tokens;
    }
    const delta = parsed.delta as Record<string, unknown>;
    if (delta?.stop_reason) s.stopReason = delta.stop_reason as string;
  }
}
