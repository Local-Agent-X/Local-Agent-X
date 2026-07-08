import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

/** Estimate token count for a string (~4 chars per token, rough but fast) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5); // Slightly conservative
}

/** Estimate tokens for a single message (content + tool calls + role overhead) */
export function messageTokens(msg: ChatCompletionMessageParam): number {
  let tokens = 4; // Role + formatting overhead

  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (typeof part === "object" && "text" in part) {
        tokens += estimateTokens(String(part.text));
      }
    }
  }

  // Tool calls in assistant messages
  const m = msg as unknown as Record<string, unknown>;
  if (m.tool_calls && Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) {
      tokens += estimateTokens(tc.function?.name || "");
      tokens += estimateTokens(tc.function?.arguments || "");
      tokens += 10; // Tool call overhead
    }
  }

  return tokens;
}

/** Estimate total tokens for a message array */
export function totalTokens(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((sum, msg) => sum + messageTokens(msg), 0);
}

/**
 * Anchor for anchored counting: a REAL usage total reported by the provider
 * (input + cache-read + cache-creation + output of the last response) plus the
 * index of the first message that response did not cover.
 */
export interface TokenAnchor {
  /** Real context size as of the anchoring response, in provider tokens. */
  anchorTokens: number;
  /** Messages[estimateFrom..] were appended after that response — estimated. */
  estimateFrom: number;
}

/**
 * Anchored total: the anchor's real usage plus the chars/3.5 estimate of only
 * the messages appended since. Far more accurate than a pure estimate — the
 * bulk of the context is counted by the provider, not guessed.
 */
export function anchoredTotalTokens(
  messages: ChatCompletionMessageParam[],
  anchor: TokenAnchor
): number {
  let sum = anchor.anchorTokens;
  for (let i = Math.max(0, anchor.estimateFrom); i < messages.length; i++) {
    sum += messageTokens(messages[i]);
  }
  return sum;
}
