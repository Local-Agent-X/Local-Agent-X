import { estimateTokens } from "./context-usage.js";

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  tool_call_id?: string;
  tool_calls?: unknown[];
  name?: string;
}

export interface CompactResult {
  messages: Message[];
  removedCount: number;
  summaryTokens: number;
  originalTokens: number;
}

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join(" ");
  }
  return "";
}

function messageTokens(msg: Message): number {
  return estimateTokens(extractText(msg.content)) + 4;
}

function isPreservable(msg: Message): boolean {
  // preserve tool call results and explicit user instructions
  if (msg.role === "tool") return true;
  if (msg.tool_calls && msg.tool_calls.length > 0) return true;
  if (msg.role === "system") return true;
  return false;
}

export function shouldCompact(messages: Message[], maxTokens: number): boolean {
  let total = 0;
  for (const msg of messages) {
    total += messageTokens(msg);
  }
  return total > maxTokens * 0.8;
}

export function compactMessages(
  messages: Message[],
  keepRecent: number = 10,
): CompactResult {
  if (messages.length <= keepRecent) {
    const totalTokens = messages.reduce((sum, m) => sum + messageTokens(m), 0);
    return { messages: [...messages], removedCount: 0, summaryTokens: 0, originalTokens: totalTokens };
  }

  const originalTokens = messages.reduce((sum, m) => sum + messageTokens(m), 0);

  // split into old messages and recent messages to keep verbatim
  const oldMessages = messages.slice(0, messages.length - keepRecent);
  const recentMessages = messages.slice(messages.length - keepRecent);

  // collect preserved items from old messages
  const preserved: string[] = [];
  const summarizable: string[] = [];

  for (const msg of oldMessages) {
    const text = extractText(msg.content);
    if (!text.trim()) continue;

    if (isPreservable(msg)) {
      const label = msg.role === "tool" ? `[tool result]` : `[${msg.role}]`;
      preserved.push(`${label} ${text.substring(0, 300)}`);
    } else {
      const label = msg.role === "user" ? "[user]" : "[assistant]";
      summarizable.push(`${label} ${text.substring(0, 200)}`);
    }
  }

  // build a condensed summary
  const parts: string[] = [];
  parts.push("Summary of earlier conversation:");

  if (summarizable.length > 0) {
    // group and condense exchanges
    const condensed = summarizable.slice(-20).join("\n");
    parts.push(condensed);
  }

  if (preserved.length > 0) {
    parts.push("\nPreserved tool results and instructions:");
    parts.push(preserved.join("\n"));
  }

  const summaryText = parts.join("\n");
  const summaryMessage: Message = {
    role: "system",
    content: summaryText,
  };

  const summaryTokens = messageTokens(summaryMessage);

  // keep any system messages from the start that aren't part of old conversation
  const leadingSystem: Message[] = [];
  let i = 0;
  while (i < oldMessages.length && oldMessages[i].role === "system") {
    leadingSystem.push(oldMessages[i]);
    i++;
  }

  const result = [...leadingSystem, summaryMessage, ...recentMessages];

  return {
    messages: result,
    removedCount: oldMessages.length - leadingSystem.length,
    summaryTokens,
    originalTokens,
  };
}
