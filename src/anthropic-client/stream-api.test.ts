import { describe, it, expect, afterEach, vi } from "vitest";

import { streamViaAPI } from "./stream-api.js";
import type { StreamEvent, StreamOptions } from "./types.js";

// SSE body builder — each event as the API frames it on the wire.
function sse(events: Array<Record<string, unknown>>): string {
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function stubFetch(body: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
}

async function collect(overrides: Partial<StreamOptions> = {}): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of streamViaAPI({
    token: "sk-ant-api03-test",
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "test",
    ...overrides,
  })) out.push(ev);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("streamViaAPI — usage capture", () => {
  it("forwards cache read/write tokens from message_start into the done event", async () => {
    stubFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 4_000 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: "end_turn" } },
    ]));
    const events = await collect();
    const done = events.find(e => e.type === "done");
    expect(done?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadTokens: 300_000,
      cacheCreateTokens: 4_000,
    });
    expect(done?.stopReason).toBe("end_turn");
  });

  it("keeps cache fields undefined (not zero) when the API omits them", async () => {
    stubFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 40 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 3 }, delta: { stop_reason: "end_turn" } },
    ]));
    const events = await collect();
    const done = events.find(e => e.type === "done");
    expect(done?.usage?.inputTokens).toBe(40);
    expect(done?.usage?.cacheReadTokens).toBeUndefined();
    expect(done?.usage?.cacheCreateTokens).toBeUndefined();
  });

  it("a zero cache read on a cold cache stays 0, not undefined", async () => {
    stubFetch(sse([
      { type: "message_start", message: { usage: { input_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 } } },
      { type: "message_delta", usage: { output_tokens: 2 }, delta: { stop_reason: "end_turn" } },
    ]));
    const events = await collect();
    const done = events.find(e => e.type === "done");
    expect(done?.usage?.cacheReadTokens).toBe(0);
    expect(done?.usage?.cacheCreateTokens).toBe(90_000);
  });
});
