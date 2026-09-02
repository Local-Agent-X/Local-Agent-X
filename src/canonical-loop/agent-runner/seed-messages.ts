import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ImageAttachment } from "../../providers/types.js";
import { appendOpMessage } from "../store.js";
import type { CanonicalMessageRole } from "../types.js";
import { buildRevivalPlan, historyImagesOf, reviveRowImages } from "../history-image-revival.js";

export function seedOpMessages(
  opId: string,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  images: ImageAttachment[] | undefined,
): void {
  let seqInTurn = 0;
  const turnIdx = 0;
  // Bounded history-image revival — the SAME policy point the chat-runner
  // seeder uses (../history-image-revival.ts): most-recent occurrence wins,
  // count/byte caps, older/excess/oversize degrade to text placeholders.
  const revivalPlan = buildRevivalPlan(history);

  for (const [rowIdx, msg] of history.entries()) {
    const role = chatRoleToCanonicalRole(msg.role);
    if (!role) continue;
    const text = extractTextContent(msg.content);

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

    // Mirror chat-runner/seed-messages.ts: a caption-less photo row arrives
    // here as text:"" plus a nonstandard `images` prop and used to fall to
    // the emptiness filter below — the model lost sight of an image it was
    // shown a turn ago. Revive those rows under the shared bounded plan.
    let rowImages: ImageAttachment[] | undefined;
    let imagePlaceholders = "";
    if (role === "user") {
      const all = historyImagesOf(msg);
      if (all.length > 0) {
        const revival = reviveRowImages(all, revivalPlan.get(rowIdx));
        rowImages = revival.images;
        imagePlaceholders = revival.placeholderText;
      }
    }

    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId && !rowImages && !imagePlaceholders) continue;

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
    if (role === "user" && (rowImages || imagePlaceholders)) {
      const combined = imagePlaceholders ? (text ? `${text}\n${imagePlaceholders}` : imagePlaceholders) : text;
      content = rowImages ? { text: combined, images: rowImages } : { text: combined };
    }

    appendOpMessage({
      messageId: `hist-${opId}-${turnIdx}-${seqInTurn}-${randomUUID().slice(0, 6)}`,
      opId,
      turnIdx,
      seqInTurn,
      role,
      content,
      createdAt: new Date().toISOString(),
    });
    seqInTurn += 1;
  }

  // Mirror chat-runner.ts: image attachments ride on the seeded user-message
  // content payload. Adapters extract `images` and convert to the provider's
  // wire format (OpenAI multi-part / Anthropic image content blocks). Without
  // this, a vision-capable spawned agent (autopilot, delegation ack, etc.)
  // never sees the user's image — only the text describing it.
  const userContent: { text: string; images?: ImageAttachment[] } = { text: userMessage };
  if (images && images.length > 0) userContent.images = images;
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

function chatRoleToCanonicalRole(role: ChatCompletionMessageParam["role"]): CanonicalMessageRole | null {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "tool": return "tool_result";
    case "system": return null;
    default: return null;
  }
}

function extractTextContent(content: ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!content || !Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } =>
      typeof p === "object" && p !== null && (p as { type?: string }).type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map(p => p.text)
    .join("\n");
}
