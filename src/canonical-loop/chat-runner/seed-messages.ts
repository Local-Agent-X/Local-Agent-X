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
import { buildRevivalPlan, historyImagesOf, reviveRowImages } from "../history-image-revival.js";

// Bounded history-image revival: caps, most-recent dedupe, and placeholder
// degradation all live in ../history-image-revival.ts — the ONE policy point
// shared with the agent-runner seeder (no second policy point). The CURRENT
// message's first-send images (prepared.images below) are deliberately not
// gated — that unconditional read predates this seam.
export { REVIVED_HISTORY_IMAGE_MAX_COUNT, REVIVED_HISTORY_IMAGE_MAX_BYTES } from "../history-image-revival.js";

export function seedOpMessages(opId: string, prepared: PreparedAgentRequest, currentMessage: string): void {
  let seqInTurn = 0;
  const turnIdx = 0;
  const revivalPlan = buildRevivalPlan(prepared.cleanHistory);

  // Canonical op_messages has no system role, so the loop below drops every
  // `role:"system"` row in cleanHistory. Those rows carry the /api/compact
  // summary and truncateHistory's digest — real prior context that is NOT in
  // prepared.systemPrompt when request preparation returns. createChatOp folds
  // them before telemetry persistence; seeding must not mutate the prompt.
  for (const [rowIdx, msg] of prepared.cleanHistory.entries()) {
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

    // User rows round-tripped from session.messages carry attachments on a
    // nonstandard `images` prop holding {name, url} — opMessageRowToChatParam
    // strips filePath for the UI projection. A caption-less photo row
    // therefore arrived here with text:"" and fell to the emptiness filter
    // below: the model lost sight of an image it was shown a turn ago.
    // Revive those rows under the bounded plan above: the winners get real
    // bytes back (the shared converter re-reads them per request, or emits
    // its standard unreadable-attachment note for a pruned upload); every
    // older/excess/oversized occurrence becomes a text placeholder so the
    // row still survives, non-empty, without ballooning every request.
    let images: PreparedAgentRequest["images"] | undefined;
    let imagePlaceholders = "";
    if (role === "user") {
      const all = historyImagesOf(msg);
      if (all.length > 0) {
        const revival = reviveRowImages(all, revivalPlan.get(rowIdx));
        images = revival.images;
        imagePlaceholders = revival.placeholderText;
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
    if (!text && !toolCalls && !isToolResultWithId && !images && !imagePlaceholders) continue;

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
    // Same content shape as the current-message row below — adapters extract
    // `images` and hand them to the shared provider converters. Placeholder
    // lines ride the row's text so a fully-placeholdered photo row is still
    // a non-empty user row, never the empty-text 400 class.
    if (role === "user" && (images || imagePlaceholders)) {
      const combined = imagePlaceholders ? (text ? `${text}\n${imagePlaceholders}` : imagePlaceholders) : text;
      content = images ? { text: combined, images } : { text: combined };
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
