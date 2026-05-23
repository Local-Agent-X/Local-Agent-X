// Per-event parser for the Codex Responses API SSE stream. Each `data: ...`
// JSON line decodes into a CodexStreamEvent; processCodexEvent translates
// one event into zero or more output yields and mutates the per-stream
// state object. The orchestrator owns the line buffer + silence timer +
// abort wiring; this module owns the event-shape decoding.

import { parseReasoningItem, type ReasoningItem } from "../codex-message-convert.js";
import { encodeToolCallId } from "../codex-message-convert.js";
import { createLogger } from "../logger.js";
import type {
  CodexStreamEvent,
  CodexStreamYield,
  CodexToolCallAccum,
} from "./types.js";

const logger = createLogger("codex-client.stream");

export interface CodexStreamState {
  fullText: string;
  // Tool calls keyed by item_id (used in streaming events as the lookup key).
  // Each entry stores the compound id (call_id|item_id), name, and arguments.
  toolCalls: Map<string, CodexToolCallAccum>;
  usage: { inputTokens: number; outputTokens: number };
  responseId: string | undefined;
  reasoningItems: ReasoningItem[];
}

export function createCodexStreamState(): CodexStreamState {
  return {
    fullText: "",
    toolCalls: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    responseId: undefined,
    reasoningItems: [],
  };
}

export async function* processCodexEvent(
  event: CodexStreamEvent,
  state: CodexStreamState,
  model: string,
): AsyncGenerator<CodexStreamYield> {
  // Text delta
  if (event.type === "response.output_text.delta" && event.delta) {
    state.fullText += event.delta;
    yield { type: "text", delta: event.delta };
    return;
  }

  // Capture tool name + IDs from output_item.added events.
  // This fires BEFORE function_call_arguments deltas and carries:
  //   item.id    = "fc_..." (the output item ID, used as item_id in deltas)
  //   item.call_id = "call_..." (the call ID used for function_call_output)
  if (event.type === "response.output_item.added") {
    const rawItem = event as unknown as Record<string, unknown>;
    const item = rawItem.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call") {
      const itemId = (item.id as string) || "";
      const callId = (item.call_id as string) || "";
      const lookupKey = itemId || callId;
      if (lookupKey) {
        const existing = state.toolCalls.get(lookupKey) || {
          id: encodeToolCallId(callId, itemId),
          callId,
          itemId,
          name: "",
          arguments: "",
        };
        if (item.name) existing.name = item.name as string;
        if (callId) existing.callId = callId;
        if (itemId) existing.itemId = itemId;
        existing.id = encodeToolCallId(existing.callId, existing.itemId);
        state.toolCalls.set(lookupKey, existing);
      }
    }
    return;
  }

  // Function call arguments delta — item_id is the lookup key (matches
  // the item.id from output_item.added). Some events use call_id instead.
  if (event.type === "response.function_call_arguments.delta") {
    const rawDelta = event as unknown as Record<string, unknown>;
    const lookupKey = (rawDelta.item_id as string) || event.call_id || "";
    if (lookupKey) {
      const existing = state.toolCalls.get(lookupKey) || {
        id: lookupKey,
        callId: event.call_id || lookupKey,
        itemId: (rawDelta.item_id as string) || "",
        name: event.name || "",
        arguments: "",
      };
      if (event.name) existing.name = event.name;
      existing.arguments += event.delta || "";
      state.toolCalls.set(lookupKey, existing);
    }
    return;
  }

  // Function call done — yield the complete tool call with compound ID
  if (event.type === "response.function_call_arguments.done") {
    const rawEvent = event as unknown as Record<string, unknown>;
    const lookupKey = (rawEvent.item_id as string) || event.call_id || "";
    const tc = lookupKey ? state.toolCalls.get(lookupKey) : undefined;
    if (tc && tc.name) {
      yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
    } else if (lookupKey) {
      const name = tc?.name || (rawEvent.name as string) || "";
      const args = (rawEvent.arguments as string) || tc?.arguments || "";
      const callId = event.call_id || (rawEvent.call_id as string) || lookupKey;
      const itemId = (rawEvent.item_id as string) || "";
      if (name || args) {
        yield { type: "tool_call", id: encodeToolCallId(callId, itemId), name, arguments: args };
      }
    }
    return;
  }

  // (Removed: image_generation_call handler. Codex OAuth endpoint
  // doesn't actually return image data in the stream — see the note
  // in request.ts around the tools block explaining why the request
  // shape doesn't work for this endpoint. User generates images via
  // browser-driven navigation to a paid LLM site instead.)

  // Response completed
  if (event.type === "response.completed" || event.type === "response.done") {
    yield* finalizeCompleted(event, state, model);
  }
}

async function* finalizeCompleted(
  event: CodexStreamEvent,
  state: CodexStreamState,
  model: string,
): AsyncGenerator<CodexStreamYield> {
  // Capture the response ID for previous_response_id on the next turn
  if (event.response?.id) {
    state.responseId = event.response.id;
  }

  if (event.response?.usage) {
    state.usage.inputTokens = event.response.usage.input_tokens || 0;
    state.usage.outputTokens = event.response.usage.output_tokens || 0;
  }
  // Extract tool calls, text, AND reasoning from the completed response.
  // Some Codex responses arrive as a single completed event without streaming
  // output_text.delta events first — we still need to surface that text.
  if (event.response?.output) {
    for (const item of event.response.output) {
      // Capture reasoning items for replay on the next turn.
      // These contain encrypted_content and summary that must be
      // sent back verbatim — the API rejects requests without them.
      if (item.type === "reasoning") {
        const reasoningItem = parseReasoningItem(item as unknown as Record<string, unknown>);
        if (reasoningItem) {
          state.reasoningItems.push(reasoningItem);
          yield { type: "reasoning", item: reasoningItem };
        }
        continue;
      }

      if (item.type === "function_call" && item.call_id) {
        // Use the item's own id (fc_...) as lookup key to avoid duplicates
        const lookupKey = (item as unknown as Record<string, unknown>).id as string || item.call_id;
        if (!state.toolCalls.has(lookupKey)) {
          const itemId = (item as unknown as Record<string, unknown>).id as string || "";
          const compoundId = encodeToolCallId(item.call_id, itemId);
          state.toolCalls.set(lookupKey, {
            id: compoundId,
            callId: item.call_id,
            itemId,
            name: item.name || "",
            arguments: item.arguments || "",
          });
          yield {
            type: "tool_call",
            id: compoundId,
            name: item.name || "",
            arguments: item.arguments || "",
          };
        }
      }
      // Recover text from message items if we never saw streaming deltas
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string" && part.text.length > state.fullText.length) {
            const missing = part.text.slice(state.fullText.length);
            if (missing) {
              state.fullText += missing;
              yield { type: "text", delta: missing };
            }
          }
        }
      }
    }
  }

  // Classify the response so upstream knows why it ended the way it did
  const outputSnapshot = event.response?.output ?? null;
  const outputTypesArr = Array.isArray(outputSnapshot) ? outputSnapshot.map((o) => o?.type || "?") : [];
  const { classifyCodexResponse, logClassification } = await import("../response-classifier.js");
  const classification = classifyCodexResponse({
    hasText: !!state.fullText.trim(),
    hasToolCalls: state.toolCalls.size > 0,
    outputTypes: outputTypesArr,
    status: (event.response as unknown as Record<string, unknown>)?.status as string | undefined,
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
    responseText: state.fullText,
  });
  logClassification("codex", model, classification);
  // Attach classification to the done event so the agent loop can use it
  (state.usage as Record<string, unknown>).classification = classification;
}

/**
 * Stream ended without response.completed — flush any tool calls that were
 * collected but never finalized, and classify the (incomplete) response.
 * Codex sometimes closes the stream after delta events but before
 * function_call_arguments.done — we'd lose the tool call otherwise.
 */
export async function* flushOnAbnormalClose(
  state: CodexStreamState,
  model: string,
): AsyncGenerator<CodexStreamYield> {
  logger.warn(`[codex] Stream ended without response.completed event. hasText=${!!state.fullText.trim()} toolCalls=${state.toolCalls.size} usage=${state.usage.inputTokens}in/${state.usage.outputTokens}out`);

  // Flush collected tool calls that were never yielded (happens on abnormal stream close)
  // Only yield if the arguments are valid JSON — partial args from truncated streams
  // produce broken tool calls with undefined fields.
  for (const tc of state.toolCalls.values()) {
    if (!tc.name) continue;
    let argsOk = false;
    try { JSON.parse(tc.arguments); argsOk = true; } catch { /* partial JSON */ }
    if (argsOk) {
      logger.warn(`[codex] Flushing unyielded tool call: ${tc.name}(${tc.arguments.slice(0, 100)})`);
      yield { type: "tool_call", id: tc.id, name: tc.name, arguments: tc.arguments };
    } else {
      logger.error(`[codex] Dropping truncated tool call: ${tc.name}(${tc.arguments.length} bytes of partial JSON). Codex stream closed mid-response — likely hit reasoning budget. Consider reducing prompt complexity or increasing max_tokens.`);
    }
  }

  const { classifyCodexResponse, logClassification } = await import("../response-classifier.js");
  const classification = classifyCodexResponse({
    hasText: !!state.fullText.trim(),
    hasToolCalls: state.toolCalls.size > 0,
    outputTypes: [],
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
    responseText: state.fullText,
  });
  logClassification("codex", model, classification);
  (state.usage as Record<string, unknown>).classification = classification;
}
