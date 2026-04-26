
import { createLogger } from "./logger.js";
const logger = createLogger("context-usage");

export interface ContextUsage {
  used: number;
  max: number;
  percentage: number;
  remaining: number;
}

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join(" ");
  }
  return "";
}

export function getContextUsage(messages: Message[], maxTokens: number): ContextUsage {
  let totalTokens = 0;

  for (const msg of messages) {
    const text = extractText(msg.content);
    totalTokens += estimateTokens(text);
    // account for role and structural overhead per message
    totalTokens += 4;
  }

  const percentage = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;
  const remaining = Math.max(0, maxTokens - totalTokens);

  if (percentage > 80) {
    logger.info(
      `[context] warning: ${percentage.toFixed(1)}% of context window used (${totalTokens}/${maxTokens} tokens)`,
    );
  }

  return {
    used: totalTokens,
    max: maxTokens,
    percentage: Math.round(percentage * 10) / 10,
    remaining,
  };
}
