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

// Captures the request init so OAuth-path tests can assert headers + body.
function stubFetchCapturing(body: string): { calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(body, { status: 200 });
  }));
  return { calls };
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

describe("streamViaAPI — direct-HTTP OAuth path", () => {
  const OAUTH = "direct-oauth:sk-ant-oat-fake";

  it("uses Bearer auth + Claude Code identity + system prefix (no x-api-key)", async () => {
    const cap = stubFetchCapturing(sse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } },
    ]));
    await collect({ token: OAUTH, model: "claude-fable-5", systemPrompt: "BE HELPFUL" });
    const { headers, body } = cap.calls[0];
    expect(headers.authorization).toBe("Bearer sk-ant-oat-fake");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    // System becomes a two-block array whose FIRST block is the exact identity.
    expect(Array.isArray(body.system)).toBe(true);
    const sys = body.system as Array<{ text: string }>;
    expect(sys[0].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[1].text).toBe("BE HELPFUL");
  });

  it("keeps bare native tool names UNCHANGED on the wire (so Claude recognizes build_app)", async () => {
    const cap = stubFetchCapturing(sse([
      { type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: "build_app" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"name\":\"x\"}" } },
      { type: "content_block_stop" },
      { type: "message_delta", usage: { output_tokens: 4 }, delta: { stop_reason: "tool_use" } },
    ]));
    const events = await collect({
      token: OAUTH, model: "claude-fable-5",
      tools: [{ name: "build_app", description: "build an app", parameters: { type: "object" } }],
    });
    const sentTools = cap.calls[0].body.tools as Array<{ name: string }>;
    expect(sentTools[0].name).toBe("build_app");
    const call = events.find(e => e.type === "tool_call");
    expect(call?.name).toBe("build_app");
    expect(call?.arguments).toBe("{\"name\":\"x\"}");
  });

  it("promotes a single-underscore mcp_ MCP-server tool to mcp__ and reverses it back", async () => {
    const cap = stubFetchCapturing(sse([
      { type: "content_block_start", content_block: { type: "tool_use", id: "tu_2", name: "mcp__linear_get_issue" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"id\":\"1\"}" } },
      { type: "content_block_stop" },
      { type: "message_delta", usage: { output_tokens: 4 }, delta: { stop_reason: "tool_use" } },
    ]));
    const events = await collect({
      token: OAUTH, model: "claude-fable-5",
      tools: [{ name: "mcp_linear_get_issue", description: "get a linear issue", parameters: { type: "object" } }],
    });
    // Outbound: promoted to the double-underscore form the billing lane accepts.
    const sentTools = cap.calls[0].body.tools as Array<{ name: string }>;
    expect(sentTools[0].name).toBe("mcp__linear_get_issue");
    // Inbound: reversed to LAX's original single-underscore name for dispatch.
    const call = events.find(e => e.type === "tool_call");
    expect(call?.name).toBe("mcp_linear_get_issue");
  });

  it("keeps x-api-key auth and a string system prompt on the plain API-key path", async () => {
    const cap = stubFetchCapturing(sse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } },
    ]));
    await collect({ token: "sk-ant-api03-real", systemPrompt: "PLAIN" });
    const { headers, body } = cap.calls[0];
    expect(headers["x-api-key"]).toBe("sk-ant-api03-real");
    expect(headers.authorization).toBeUndefined();
    expect(body.system).toBe("PLAIN");
  });
});
