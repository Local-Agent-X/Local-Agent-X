// Anthropic prompt-caching breakpoint placement — the system tier and the
// message tier. Extracted from stream-api.ts so the request builder stays
// readable; these two functions are the whole policy for WHERE a
// `cache_control` marker lands.
//
// Prefix order on the wire is tools → system → messages, so a marker caches
// everything above it. The rule both helpers encode: a breakpoint must sit on
// content that will be BYTE-IDENTICAL on the next request, otherwise the
// cached block is re-written every turn at 1.25x and never read back at 0.1x.

import type { AnthropicContent, AnthropicMessage } from "./types.js";

export type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } };

// True when splitSystemBlocks will emit a [stable | volatile] pair. Only then
// is the tools + stable-system prefix worth a 1-hour breakpoint: it changes
// rarely (a grown tool set, an edited prompt file), so the 2x write is paid
// seldom while every 5-60 minute pause between user messages reads it back
// instead of re-writing it. The conversation tier stays on the 5-minute
// default — it changes every round, and 1-hour entries must precede 5-minute
// ones in the prefix, which tools -> system -> messages already guarantees.
export function hasStableSystemSplit(systemPrompt: string, stableLen?: number): boolean {
  return stableLen !== undefined && stableLen > 0 && stableLen < systemPrompt.length;
}

// System prompt → text blocks. Without a valid split point: one block carrying
// the breakpoint (the long-standing behavior). With one: [stable w/ breakpoint,
// volatile tail uncached], so a per-turn tail rewrite costs only the tail
// instead of missing the whole tools+system tier.
export function splitSystemBlocks(systemPrompt: string, stableLen?: number, tailInMessages = false): SystemBlock[] {
  if (hasStableSystemSplit(systemPrompt, stableLen)) {
    const stable: SystemBlock = { type: "text", text: systemPrompt.slice(0, stableLen), cache_control: { type: "ephemeral", ttl: "1h" } };
    // The tail travels at the end of the conversation instead (withSystemTail).
    return tailInMessages ? [stable] : [stable, { type: "text", text: systemPrompt.slice(stableLen) }];
  }
  return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
}

/** What opens the system prompt's per-turn tail when it is sent in the conversation. */
export const SYSTEM_TAIL_HEADER =
  "[From the app, not from the user: this turn's context. It continues your system prompt and has the same standing.]\n";

// The system prompt's per-turn tail (memory recalled for this message, the
// clock, notices), sent as the last text of the last user row instead of as a
// system block. A system block that changes every turn sits IN FRONT of the
// conversation, so nothing after it can be read from cache: a spoken turn
// re-sent its whole thread uncached every time, 10K tokens on a fresh thread
// and 120K on a long one, and the wait for the first word grew with it
// (2026-11-10). At the end, everything before it is byte-identical turn over
// turn. The row it lands on is volatile: the caller counts it in the
// ephemeral tail so the breakpoint sits beneath it.
export function withSystemTail(messages: AnthropicMessage[], tail: string): AnthropicMessage[] {
  const block: AnthropicContent = { type: "text", text: SYSTEM_TAIL_HEADER + tail };
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return [...messages, { role: "user", content: [block] }];
  const own: AnthropicContent[] = typeof last.content === "string"
    ? (last.content ? [{ type: "text", text: last.content }] : [])
    : last.content;
  return [...messages.slice(0, -1), { ...last, content: [...own, block] }];
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
  /** POST-conversion index of the last row of settled history (the tool-round
   *  prune's last stubbed row): a second breakpoint, so a prune batch, which
   *  only changes rows after it, reads everything up to it back instead of
   *  rewriting the history. With tools and system that makes four, the API's
   *  limit. Placed only strictly below the main breakpoint. */
  frontier?: number,
): AnthropicMessage[] {
  if (!enabled || messages.length === 0) return messages;
  // A tail that would swallow the whole conversation leaves NOTHING stable to
  // mark. The old clamp pinned the marker at index 0 — i.e. onto the very row
  // the caller just declared volatile, which is the one thing this file
  // forbids: the block is re-written at 1.25x every turn and never read back.
  // Emitting no marker at all is strictly better (the system tier still
  // carries its own breakpoint), and the message tier starts paying again on
  // the first turn there is a stable row beneath the tail.
  if (ephemeralTail >= messages.length) return messages;
  const idx = messages.length - 1 - Math.max(0, ephemeralTail);
  const out = [...messages];
  markMessage(out, idx);
  if (frontier !== undefined && frontier >= 0 && frontier < idx) markMessage(out, frontier);
  return out;
}

/** Put the breakpoint on the last block of out[idx], in place. */
function markMessage(out: AnthropicMessage[], idx: number): void {
  const target = out[idx];
  let content: AnthropicContent[];
  if (typeof target.content === "string") {
    if (!target.content) return;
    content = [{ type: "text", text: target.content, cache_control: { type: "ephemeral" } }];
  } else {
    if (target.content.length === 0) return;
    content = [...target.content];
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
  }
  out[idx] = { ...target, content };
}
