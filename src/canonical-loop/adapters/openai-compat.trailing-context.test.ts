/**
 * The per-op prompt sections ride the LAST user-role row on the local wire
 * (EXP-12c). Pinned at the adapter's choke point: what streamOnce receives is
 * what goes on the wire, so the system message must be the head alone and the
 * trailing row must be last, framed, and folded into an existing final user
 * row rather than stacked after it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 65_536, provenance: "probed" as const })),
}));
vi.mock("../../providers/types.js", () => ({ markNoToolSupport: vi.fn() }));
vi.mock("../../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { appendTrailingContext } from "./openai-compat/canonical-to-chat-param.js";
import { RECALLED_CONTEXT_CLOSE, RECALLED_CONTEXT_OPEN } from "../../harness-text.js";
import type { TurnInput } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);

const HEAD = "You are Agent X. [stable head]";
const TAIL = "<untrusted-recalled-data source=\"relevant-memories\">the user likes tea</untrusted-recalled-data>";

function result(): StreamOnceResult {
  return { assembledText: "ok", assembledThinking: "", pendingToolCalls: [], firstError: null, providerStop: "stop", usagePromptTokens: 10, usageCompletionTokens: 1, interruptedByInject: false };
}

function adapter(trailingContext?: string) {
  return createOpenAICompatAdapter({ model: "qwen3.6:27b", baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama", systemPrompt: HEAD, trailingContext });
}

function input(messages: TurnInput["messages"]): TurnInput {
  return { opId: "op-1", turnIdx: 1, messages, tools: [] };
}

beforeEach(() => { vi.clearAllMocks(); mockStream.mockResolvedValue(result()); });

describe("trailing context on the local wire", () => {
  it("the system message is the head alone and the recalled block is folded into the final user row", async () => {
    await adapter(TAIL).runTurn(input([{ messageId: "u1", role: "user", content: { text: "hello" } }]), () => {});
    const req = mockStream.mock.calls[0][0];
    expect(req.systemPrompt).toBe(HEAD);
    expect(req.systemPrompt).not.toContain(TAIL);
    const last = req.messages.at(-1) as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content).toBe(`hello\n\n${RECALLED_CONTEXT_OPEN}\n${TAIL}\n${RECALLED_CONTEXT_CLOSE}`);
    expect(req.messages).toHaveLength(1);
  });

  it("after a tool round the block becomes its own last row, never a second user row after a user row", async () => {
    await adapter(TAIL).runTurn(input([
      { messageId: "u1", role: "user", content: { text: "read it" } },
      { messageId: "a1", role: "assistant", content: { text: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] } },
      { messageId: "t1", role: "tool_result", content: { toolCallId: "c1", result: "contents", status: "ok" } },
    ]), () => {});
    const msgs = mockStream.mock.calls[0][0].messages as Array<{ role: string; content: unknown }>;
    expect(msgs.at(-1)?.role).toBe("user");
    expect(String(msgs.at(-1)?.content)).toContain(RECALLED_CONTEXT_OPEN);
    expect(msgs.at(-2)?.role).toBe("tool");
  });

  it("without trailing context the wire is unchanged", async () => {
    await adapter(undefined).runTurn(input([{ messageId: "u1", role: "user", content: { text: "hello" } }]), () => {});
    const req = mockStream.mock.calls[0][0];
    expect(req.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.stringify(req)).not.toContain("RECALLED CONTEXT");
  });

  it("appendTrailingContext: whitespace-only context appends nothing", () => {
    const msgs = [{ role: "user" as const, content: "hi" }];
    expect(appendTrailingContext(msgs, "  \n ")).toBe(msgs);
  });
});
