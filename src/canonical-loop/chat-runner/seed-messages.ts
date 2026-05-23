// Pre-seed `op_messages` with the prepared conversation history followed by
// the current user message. Runs BEFORE `canonicalLoopEntry` so the loop's
// worker, on first turn, sees the full history instead of just the default
// `seedInitialUserMessage` rendering.

import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { PreparedAgentRequest } from "../../agent-request/types.js";
import type { OpMessageRow } from "../types.js";
import { appendOpMessage } from "../store.js";
import { messageRoleToCanonicalRole, extractTextContent } from "./message-convert.js";

export function seedOpMessages(opId: string, prepared: PreparedAgentRequest, currentMessage: string): void {
  let seqInTurn = 0;
  const turnIdx = 0;

  for (const msg of prepared.cleanHistory) {
    const role = messageRoleToCanonicalRole(msg.role);
    if (!role) continue;
    const text = extractTextContent(msg.content);

    // Carry tool_calls through on assistant messages. The codex adapter's
    // convertMessages reads `content.toolCalls` and emits function_call
    // items in the API input; without this round-trip, a session whose
    // history includes a tool-using turn surfaces orphan
    // function_call_outputs ("No tool call found for function call output
    // with call_id ..." 400s on Codex). The tool_call's id is the compound
    // call_id|item_id encoded by codex-message-convert.
    let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
    if (role === "assistant") {
      const m = msg as ChatCompletionMessageParam & {
        tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        toolCalls = m.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        }));
      }
    }

    // Skip empty assistant rows ONLY when there are also no tool calls —
    // a tool-only assistant turn (no text, just function calls) is
    // structurally important for Codex pairing and must be persisted.
    // Same rule applies to tool_result rows: a tool message with empty
    // text but a real tool_call_id is still load-bearing — dropping it
    // orphans the matching assistant tool_call on the next Codex turn,
    // surfacing as the "No tool output found for function call X" 400
    // error. So preserve tool_result rows whenever they carry a
    // tool_call_id, regardless of text content.
    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId) continue;

    // For tool_result rows, embed tool_call_id inside the content payload
    // (canonical OpMessageRow has a free-form `content` field; the adapter
    // reads tool_call_id from there when converting to provider messages).
    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }
    if (role === "assistant" && toolCalls) {
      content = { text, toolCalls };
    }

    const row: OpMessageRow = {
      messageId: `hist-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId,
      turnIdx,
      seqInTurn,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    appendOpMessage(row);
    seqInTurn += 1;
  }

  // Current user message — last in the seed so the model sees it as the
  // "ask". seedInitialUserMessage is a no-op when op_messages is non-empty,
  // so this row replaces its default behavior with our prepared payload.
  // Image attachments ride on the same content payload — adapters extract
  // `images` and convert to their provider's wire format (OpenAI multi-
  // part for OpenAI-compat, image content blocks for Anthropic).
  const userContent: { text: string; images?: PreparedAgentRequest["images"] } = { text: currentMessage };
  if (prepared.images && prepared.images.length > 0) userContent.images = prepared.images;
  appendOpMessage({
    messageId: `um-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
    opId,
    turnIdx,
    seqInTurn,
    role: "user",
    content: userContent,
    createdAt: new Date().toISOString(),
  });
}
