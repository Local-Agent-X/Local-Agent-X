import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderRequest, StreamChunk } from "../providers/adapter/types.js";
import { noteFreshChatHead, prewarmNewChat, _resetPrewarmForTests } from "./prompt-prewarm.js";

const tools = [{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }] as unknown as ProviderRequest["tools"];

function firstRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    apiKey: "ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen3.6:27b",
    systemPrompt: "SYSTEM HEAD",
    messages: [{ role: "user", content: "the user's real first message" }],
    tools,
    temperature: 0.7,
    reasoningEffort: "medium",
    sessionId: "chat-a",
    toolChoice: "required",
    ...overrides,
  };
}

function recorder() {
  const sent: ProviderRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  async function* send(req: ProviderRequest): AsyncIterable<StreamChunk> {
    sent.push(req);
    await gate;
    yield { type: "usage", promptTokens: 100, completionTokens: 1, cachedTokens: 0 };
  }
  return { sent, send, release: () => release() };
}

const onLocal = { provider: "local", model: "qwen3.6:27b" };

describe("new-chat prompt pre-warm", () => {
  beforeEach(() => _resetPrewarmForTests());

  it("does nothing until a fresh local chat has been seen", () => {
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: recorder().send })).toBe("no-head");
  });

  it("replays the recorded system prompt and tools with a one-word turn and a one-token cap", async () => {
    noteFreshChatHead(firstRequest());
    const r = recorder();
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: r.send })).toBe("started");
    await Promise.resolve();
    expect(r.sent).toHaveLength(1);
    const req = r.sent[0];
    expect(req.systemPrompt).toBe("SYSTEM HEAD");
    expect(req.tools).toBe(tools);
    expect(req.model).toBe("qwen3.6:27b");
    expect(req.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(req.reasoningEffort).toBe("medium");
    expect(req.messages).toEqual([{ role: "user", content: "." }]);
    expect(req.maxTokens).toBe(1);
    // Nothing chat-specific rides along.
    expect(req.sessionId).toBeUndefined();
    expect(req.toolChoice).toBeUndefined();
    r.release();
  });

  it("never records a cloud endpoint", () => {
    noteFreshChatHead(firstRequest({ baseURL: "https://api.openai.com/v1" }));
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: recorder().send })).toBe("no-head");
  });

  it("skips when the chat has moved to another provider or model", () => {
    noteFreshChatHead(firstRequest());
    const r = recorder();
    expect(prewarmNewChat({ current: { provider: "anthropic", model: "qwen3.6:27b" }, foregroundBusy: false, send: r.send })).toBe("other-model");
    expect(prewarmNewChat({ current: { provider: "local", model: "qwen3:8b" }, foregroundBusy: false, send: r.send })).toBe("other-model");
    expect(r.sent).toHaveLength(0);
  });

  it("skips while a foreground turn runs, and runs one pre-warm at a time", async () => {
    noteFreshChatHead(firstRequest());
    const r = recorder();
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: true, send: r.send })).toBe("busy");
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: r.send })).toBe("started");
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: r.send })).toBe("busy");
    r.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: recorder().send })).toBe("started");
  });

  it("a failed replay frees the slot and never throws", async () => {
    noteFreshChatHead(firstRequest());
    async function* failing(): AsyncIterable<StreamChunk> { throw new Error("connection refused"); }
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: failing })).toBe("started");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prewarmNewChat({ current: onLocal, foregroundBusy: false, send: recorder().send })).toBe("started");
  });
});
