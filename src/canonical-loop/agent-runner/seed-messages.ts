import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ImageAttachment } from "../../providers/types.js";
import { appendOpMessage } from "../store.js";
import type { CanonicalMessageRole } from "../types.js";

export function seedOpMessages(
  opId: string,
  history: ChatCompletionMessageParam[],
  userMessage: string,
  images: ImageAttachment[] | undefined,
): void {
  let seqInTurn = 0;
  const turnIdx = 0;

  for (const msg of history) {
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

    const isToolResultWithId = role === "tool_result" && (msg as ChatCompletionMessageParam & { tool_call_id?: string }).tool_call_id;
    if (!text && !toolCalls && !isToolResultWithId) continue;

    let content: unknown = { text };
    if (role === "tool_result") {
      const toolMsg = msg as ChatCompletionMessageParam & { tool_call_id?: string };
      if (toolMsg.tool_call_id) content = { text, toolCallId: toolMsg.tool_call_id };
    }
    if (role === "assistant" && toolCalls) {
      content = { text, toolCalls };
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
