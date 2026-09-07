// F3 — the LAST hop of the ephemeral-tail chain: transport → wire.
//
// anthropic-ephemeral-tail.test.ts covers adapter → transport request, and
// stream-api.test.ts covers markConversationCache once the count reaches
// StreamOptions. The hop BETWEEN them — defaultAnthropicTransport copying
// req.ephemeralTailMessages onto the streamAnthropicResponse options — had no
// test at all: deleting that one line left 178/178 green while restoring the
// whole 4.85M-write bug, because the request still succeeds and only the
// caching silently stops.
//
// Mutation check: change `ephemeralTailMessages: req.ephemeralTailMessages`
// in anthropic-transport.ts to `undefined` — this file must go red.
import { describe, it, expect, vi } from "vitest";

const captured: Array<Record<string, unknown>> = [];

vi.mock("../../anthropic-client/index.js", () => ({
  async *streamAnthropicResponse(options: Record<string, unknown>) {
    captured.push(options);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
}));
vi.mock("../../auth/anthropic.js", () => ({
  getAnthropicApiKey: async () => "cli",
  getAnthropicDirectToken: async () => null,
}));

import { defaultAnthropicTransport } from "./anthropic-transport.js";
import type { AnthropicTransportRequest } from "./anthropic.js";

function request(extra: Partial<AnthropicTransportRequest> = {}): AnthropicTransportRequest {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "ship it" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "[SITUATIONAL CONTEXT …]" },
    ],
    tools: [],
    signal: new AbortController().signal,
    cacheConversation: true,
    ...extra,
  };
}

async function drain(req: AnthropicTransportRequest): Promise<void> {
  for await (const _ of defaultAnthropicTransport().stream(req)) { /* consume */ }
}

describe("defaultAnthropicTransport — cache fields reach the wire options", () => {
  it("passes ephemeralTailMessages through to streamAnthropicResponse", async () => {
    captured.length = 0;
    await drain(request({ ephemeralTailMessages: 1 }));
    expect(captured).toHaveLength(1);
    expect(captured[0].ephemeralTailMessages).toBe(1);
    // Its two companions ride the same literal and are just as silent to lose.
    expect(captured[0].cacheConversation).toBe(true);
  });

  it("passes a larger tail count through unchanged (never clamped here)", async () => {
    captured.length = 0;
    await drain(request({ ephemeralTailMessages: 3, systemStablePrefixLen: 12 }));
    expect(captured[0].ephemeralTailMessages).toBe(3);
    expect(captured[0].systemStablePrefixLen).toBe(12);
  });

  it("leaves the field undefined when the caller declares no ephemeral tail", async () => {
    captured.length = 0;
    await drain(request());
    expect(captured[0].ephemeralTailMessages).toBeUndefined();
  });
});
