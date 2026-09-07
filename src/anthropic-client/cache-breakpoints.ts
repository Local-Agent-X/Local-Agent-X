// Anthropic prompt-caching breakpoint placement — the system tier and the
// message tier. Extracted from stream-api.ts so the request builder stays
// readable (and under the 400-LOC gate); these two functions are the whole
// policy for WHERE a `cache_control` marker lands.
//
// Prefix order on the wire is tools → system → messages, so a marker caches
// everything above it. The rule both helpers encode: a breakpoint must sit on
// content that will be BYTE-IDENTICAL on the next request, otherwise the
// cached block is re-written every turn at 1.25x and never read back at 0.1x.

import type { AnthropicContent, AnthropicMessage } from "./types.js";

export type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

// System prompt → text blocks. Without a valid split point: one block carrying
// the breakpoint (the long-standing behavior). With one: [stable w/ breakpoint,
// volatile tail uncached], so a per-turn tail rewrite costs only the tail
// instead of missing the whole tools+system tier.
export function splitSystemBlocks(systemPrompt: string, stableLen?: number): SystemBlock[] {
  if (stableLen !== undefined && stableLen > 0 && stableLen < systemPrompt.length) {
    return [
      { type: "text", text: systemPrompt.slice(0, stableLen), cache_control: { type: "ephemeral" } },
      { type: "text", text: systemPrompt.slice(stableLen) },
    ];
  }
  return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
}

// Message-tier breakpoint: mark the last block of the last STABLE message so
// the conversation prefix up to that point is cacheable. String content
// becomes a single text block (cache_control only exists on block form).
// No-op when the flag is off or the conversation is empty.
//
// `ephemeralTail` (default 0) is how many trailing messages the caller
// regenerates every turn — the canonical loop's situational-awareness digest
// is one such row. Marking the true last message there caches VOLATILE bytes:
// the prefix diverges at that block every turn, nothing can be read back, and
// the entire conversation is re-written to cache each turn at 1.25x for
// nothing (measured: 4.85M written / 4.39M read on a 76-turn chat, with
// cacheRead pinned at exactly the system-tier figure every single turn).
// Marking beneath the tail keeps the cached region byte-identical turn over
// turn. The count is in POST-conversion messages — the tail rows must survive
// convertMessages 1:1 (plain user text does).
export function markConversationCache(
  messages: AnthropicMessage[],
  enabled?: boolean,
  ephemeralTail = 0,
): AnthropicMessage[] {
  if (!enabled || messages.length === 0) return messages;
  const idx = messages.length - 1 - Math.max(0, Math.min(ephemeralTail, messages.length - 1));
  const target = messages[idx];
  let content: AnthropicContent[];
  if (typeof target.content === "string") {
    if (!target.content) return messages;
    content = [{ type: "text", text: target.content, cache_control: { type: "ephemeral" } }];
  } else {
    if (target.content.length === 0) return messages;
    content = [...target.content];
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
  }
  const out = [...messages];
  out[idx] = { ...target, content };
  return out;
}
