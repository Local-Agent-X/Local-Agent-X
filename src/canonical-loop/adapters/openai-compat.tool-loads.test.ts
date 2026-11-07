/**
 * At the adapter: on a discovered Ollama runtime whose model's parser keeps a
 * call to a tool outside `tools` (qwen3.5), a tool loaded mid-op leaves the tool
 * list and shows in its tool_search result, so the request after the load
 * starts with the request before it. Text rescue still matches the loaded tool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
  promoteCutOffReasoning: vi.fn(),
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 172_032, provenance: "probed" as const })),
}));
vi.mock("../../providers/types.js", () => ({ markNoToolSupport: vi.fn() }));
vi.mock("../../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));
const local = vi.hoisted(() => ({ parser: "qwen3.5" as string | undefined }));
vi.mock("../../local-runtimes/cache.js", async (orig) => ({
  ...(await orig<typeof import("../../local-runtimes/cache.js")>()),
  getLocalModel: vi.fn(() => ({ id: "qwen3.8:27b", contextWindow: 172_032, tools: true, ...(local.parser ? { toolParser: local.parser } : {}) })),
  ollamaNativeRootForChatBase: vi.fn(() => "http://127.0.0.1:11434"),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { applyToolCallTextFallback, streamOnce } from "./openai-compat/stream-once.js";
import type { TurnInput } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";
import { formatToolSearchResult } from "../../tools/tool-search-result.js";

const mockStream = vi.mocked(streamOnce);
const BASE = "http://127.0.0.1:11434/v1";

function result(): StreamOnceResult {
  return { assembledText: "ok", assembledThinking: "", pendingToolCalls: [], firstError: null, providerStop: "stop", usagePromptTokens: 10, usageCompletionTokens: 1, interruptedByInject: false };
}

const tool = (name: string) => ({ name, description: `${name} does a thing.`, inputSchema: { type: "object", properties: {} } });

/** Round 0 before the load; round 1 after tool_search loaded gmail_read. */
function round(turn: 0 | 1): TurnInput {
  const messages: TurnInput["messages"] = [{ messageId: "u1", role: "user", content: { text: "read my latest email" } }];
  if (turn === 1) {
    messages.push({ messageId: "a0", role: "assistant", content: { text: "", toolCalls: [{ id: "s1", name: "tool_search", arguments: '{"query":"gmail_read"}' }] } });
    messages.push({ messageId: "t0", role: "tool_result", content: { toolCallId: "s1", result: formatToolSearchResult([{ name: "gmail_read", description: "gmail_read does a thing." }]), status: "ok" } });
  }
  const tools = turn === 0 ? [tool("tool_search")] : [tool("tool_search"), tool("gmail_read")];
  return { opId: "op-1", turnIdx: turn, messages, tools };
}

async function requests() {
  const adapter = createOpenAICompatAdapter({ model: "qwen3.8:27b", baseURL: BASE, apiKey: "ollama", systemPrompt: "head" });
  await adapter.runTurn(round(0), () => {});
  await adapter.runTurn(round(1), () => {});
  return mockStream.mock.calls.map((c) => c[0]);
}

beforeEach(() => { vi.clearAllMocks(); mockStream.mockResolvedValue(result()); local.parser = "qwen3.5"; });

describe("a tool loaded mid-op on a local model", () => {
  it("leaves the tool list unchanged, and the earlier rows byte for byte", async () => {
    const [first, next] = await requests();
    expect(next.tools.map((t) => t.name)).toEqual(["tool_search"]);
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    const loaded = JSON.parse(String(next.messages.at(-1)?.content)) as Array<{ name: string; parameters?: unknown }>;
    expect(loaded).toEqual([{ name: "gmail_read", description: "gmail_read does a thing.", parameters: { type: "object", properties: {} } }]);
  });

  it("text rescue still knows the loaded tool", async () => {
    await requests();
    const callable = vi.mocked(applyToolCallTextFallback).mock.calls.at(-1)?.[3];
    expect([...(callable ?? [])].sort()).toEqual(["gmail_read", "tool_search"]);
  });

  it("joins the tool list as before for a model whose parser would drop the call", async () => {
    local.parser = undefined;
    const [, next] = await requests();
    expect(next.tools.map((t) => t.name)).toEqual(["tool_search", "gmail_read"]);
  });
});
