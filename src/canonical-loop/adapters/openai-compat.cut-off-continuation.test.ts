// The adapter continues a cut-off reply on a discovered Ollama runtime before
// anything judges it: the second leg's request ends with the cut reply as an
// assistant row, the turn finalizes what the legs produced together, and the
// reasoning-only promotion waits for the final leg. On any other transport
// the turn is left to the turn loop's cut-off re-drive, promoted as before.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai-compat/stream-once.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openai-compat/stream-once.js")>();
  return { ...actual, streamOnce: vi.fn(), applyToolCallTextFallback: vi.fn() };
});
vi.mock("./openai-compat/chat-transport.js", () => ({ chatTransportName: vi.fn(async () => "ollama-native") }));
vi.mock("../../context-manager/model-windows.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../context-manager/model-windows.js")>();
  return { ...actual, resolveContextWindow: () => ({ tokens: 172_032, provenance: "probed" as const }) };
});
vi.mock("../../providers/tool-capability-probe.js", () => ({ maybeVerifyToolSupport: vi.fn(), noteLiveToolCallEvidence: vi.fn() }));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import { chatTransportName } from "./openai-compat/chat-transport.js";
import { THINKING_BUDGET_CLOSE } from "./openai-compat/cut-off-continuation.js";
import { LOCAL_DEFAULT_MAX_TOKENS } from "./openai-compat/local-cap.js";
import type { AdapterReport, TurnInput } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const mockTransport = vi.mocked(chatTransportName);

function reply(over: Partial<StreamOnceResult> = {}): StreamOnceResult {
  return {
    assembledText: "", assembledThinking: "", pendingToolCalls: [], firstError: null,
    providerStop: "length", usagePromptTokens: 2_000, usageCompletionTokens: 16_384, interruptedByInject: false, ...over,
  };
}
const toolCall = { id: "c1", name: "bash", arguments: "{\"command\":\"xxd main.db-wal | head\"}" };
const input: TurnInput = {
  opId: "op-cut", turnIdx: 0,
  messages: [{ messageId: "u-0", role: "user", content: { text: "recover the WAL" } }],
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
};
const adapter = () => createOpenAICompatAdapter({ model: "qwen3.8:27b", baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama", systemPrompt: "s" });

beforeEach(() => {
  vi.clearAllMocks();
  mockTransport.mockResolvedValue("ollama-native");
});

describe("a cut-off reply on a discovered Ollama runtime", () => {
  it("is continued from its thinking, and the turn is what the legs produced together", async () => {
    mockStream
      .mockResolvedValueOnce(reply({ assembledThinking: "the header bytes are 0x42 everywhere, so" }))
      .mockResolvedValueOnce(reply({ pendingToolCalls: [toolCall], providerStop: "tool_calls", usageCompletionTokens: 90 }));
    const reports: AdapterReport[] = [];
    const result = await adapter().runTurn(input, r => reports.push(r));

    expect(mockStream).toHaveBeenCalledTimes(2);
    const [first, second] = mockStream.mock.calls.map(c => c[0]);
    expect(first.maxTokens).toBe(LOCAL_DEFAULT_MAX_TOKENS);
    expect(second.messages.at(-1)).toEqual({
      role: "assistant", content: "", reasoning: `the header bytes are 0x42 everywhere, so\n\n${THINKING_BUDGET_CLOSE}`,
    });
    expect(second.messages.slice(0, -1)).toEqual(first.messages);
    expect(second.maxTokens).toBe(LOCAL_DEFAULT_MAX_TOKENS);
    // The first leg is streamed as it is: the promotion waits for the final one.
    expect(mockStream.mock.calls[0][2]).toMatchObject({ keepCutOffReasoning: true });

    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized && finalized.kind === "message_finalized" ? finalized.message.content : null)
      .toEqual({ text: "", toolCalls: [toolCall] });
    expect(result.terminalReason).toBeUndefined();
    expect(result.modelStop).toBe("continue");
    expect(result.providerState.providerPayload).toMatchObject({ cutOffContinuations: 1, stopReason: "tool_calls", usageOutputTokens: 16_474 });
    expect(reports.filter(r => r.kind === "stream_chunk")).toHaveLength(0);
  });

  it("still cut after its legs: promoted and handed to the turn loop as a cut-off turn", async () => {
    mockStream.mockResolvedValue(reply({ assembledThinking: "still thinking" }));
    const reports: AdapterReport[] = [];
    const result = await adapter().runTurn(input, r => reports.push(r));
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(result.providerState.providerPayload).toMatchObject({ stopReason: "length", cutOffContinuations: 2 });
    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized && finalized.kind === "message_finalized" ? finalized.message.content : null)
      .toEqual({ text: "still thinking\n\nstill thinking\n\nstill thinking" });
    expect(reports.filter(r => r.kind === "stream_chunk")).toHaveLength(1);
  });
});

describe("on any other transport", () => {
  it("the cut reply is left to the turn loop, with no continuation, promoted by the stream itself", async () => {
    mockTransport.mockResolvedValue("openai-http");
    // What streamOnce returns when it is asked to promote (keepCutOffReasoning false).
    mockStream.mockResolvedValueOnce(reply({ assembledThinking: "thought", assembledText: "thought", rawText: "" }));
    const reports: AdapterReport[] = [];
    const result = await adapter().runTurn(input, r => reports.push(r));
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockStream.mock.calls[0][2]).toMatchObject({ keepCutOffReasoning: false });
    expect(result.providerState.providerPayload).toMatchObject({ stopReason: "length" });
    expect(result.providerState.providerPayload).not.toHaveProperty("cutOffContinuations");
    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized && finalized.kind === "message_finalized" ? finalized.message.content : null).toEqual({ text: "thought" });
  });
});
