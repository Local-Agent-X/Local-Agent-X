// Phase 1 token plumbing: the usage chunk's cached_tokens and the done chunk's
// time-to-first-token land on StreamOnceResult, where openai-compat records
// them on the turn as cacheReadTokens / ttftMs — the same fields the Anthropic
// adapter uses — so local turns price and profile without a second path.
import { describe, it, expect, vi } from "vitest";

const streamMock = vi.fn();
vi.mock("../../../providers/adapters/openai-http.js", () => ({
  openaiHttpAdapter: { stream: streamMock },
}));

import { streamOnce } from "./stream-once.js";
import type { ProviderRequest } from "../../../providers/adapter/types.js";

function req(): ProviderRequest {
  return {
    apiKey: "k",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as ProviderRequest;
}

describe("streamOnce usage plumbing", () => {
  it("keeps cached_tokens and time-to-first-token from the adapter", async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: "text", delta: "ok" };
      yield { type: "usage", promptTokens: 120, completionTokens: 7, cachedTokens: 100 };
      yield { type: "done", stopReason: "stop", firstTokenMs: 42 };
    });
    const out = await streamOnce(req(), () => {}, { isAborted: () => false });
    expect(out.usagePromptTokens).toBe(120);
    expect(out.usageCompletionTokens).toBe(7);
    expect(out.usageCachedTokens).toBe(100);
    expect(out.firstTokenMs).toBe(42);
  });

  it("leaves both undefined when the endpoint reports nothing", async () => {
    streamMock.mockImplementation(async function* () {
      yield { type: "text", delta: "ok" };
      yield { type: "done", stopReason: "stop" };
    });
    const out = await streamOnce(req(), () => {}, { isAborted: () => false });
    expect(out.usageCachedTokens).toBeUndefined();
    expect(out.firstTokenMs).toBeUndefined();
  });
});
