/**
 * At the adapter's choke point, over several rounds of one op: on a local
 * endpoint each request starts with the previous request byte for byte, so a
 * hybrid model (qwen3.6) can reuse its cache; on a cloud endpoint the request
 * is built as before. Terminal-Bench 2.0 (2026-10-20) caught the old wire
 * dropping and replacing the digest row every round, which made Ollama re-read
 * the whole conversation every turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai-compat/stream-once.js", () => ({
  streamOnce: vi.fn(),
  applyToolCallTextFallback: vi.fn(),
}));
vi.mock("../../context-manager/model-windows.js", () => ({
  resolveContextWindow: vi.fn(() => ({ tokens: 172_032, provenance: "probed" as const })),
}));
vi.mock("../../providers/types.js", () => ({ markNoToolSupport: vi.fn() }));
vi.mock("../../providers/tool-capability-probe.js", () => ({
  maybeVerifyToolSupport: vi.fn(),
  noteLiveToolCallEvidence: vi.fn(),
}));

import { createOpenAICompatAdapter } from "./openai-compat.js";
import { streamOnce } from "./openai-compat/stream-once.js";
import type { TurnInput } from "../adapter-contract.js";
import type { StreamOnceResult } from "./openai-compat/types.js";

const mockStream = vi.mocked(streamOnce);
const TAIL = "<untrusted-recalled-data>the user likes tea</untrusted-recalled-data>";

function result(): StreamOnceResult {
  return { assembledText: "ok", assembledThinking: "", pendingToolCalls: [], firstError: null, providerStop: "stop", usagePromptTokens: 10, usageCompletionTokens: 1, interruptedByInject: false };
}

/** Round `turn` of an op: the history so far, then the loop's digest row. */
function roundInput(turn: number): TurnInput {
  const messages: TurnInput["messages"] = [{ messageId: "u1", role: "user", content: { text: "build pmars" } }];
  for (let i = 0; i < turn; i++) {
    messages.push({ messageId: `a${i}`, role: "assistant", content: { text: "", toolCalls: [{ id: `c${i}`, name: "bash", arguments: `{"command":"step ${i}"}` }] } });
    messages.push({ messageId: `t${i}`, role: "tool_result", content: { toolCallId: `c${i}`, result: `out ${i}`, status: "ok" } });
  }
  messages.push({ messageId: `sa-${turn}`, role: "user", content: { text: `[SITUATIONAL CONTEXT] Turn ${turn + 1} · ~${turn * 9}k tokens used` } });
  return { opId: "op-1", turnIdx: turn, messages, tools: [{ name: "bash", description: "", inputSchema: {} }], ephemeralTailMessages: 1 };
}

async function sent(baseURL: string, rounds: number) {
  const adapter = createOpenAICompatAdapter({ model: "qwen3.6:27b", baseURL, apiKey: "ollama", systemPrompt: "head", trailingContext: TAIL });
  for (let turn = 0; turn < rounds; turn++) await adapter.runTurn(roundInput(turn), () => {});
  return mockStream.mock.calls.map((c) => JSON.parse(JSON.stringify(c[0].messages)) as unknown[]);
}

beforeEach(() => { vi.clearAllMocks(); mockStream.mockResolvedValue(result()); });

describe("the local wire over the rounds of one op", () => {
  it("sends each round as a strict extension of the round before", async () => {
    const requests = await sent("http://127.0.0.1:11434/v1", 5);
    for (let r = 1; r < requests.length; r++) {
      const prev = requests[r - 1];
      expect(requests[r].slice(0, prev.length), `round ${r}`).toEqual(prev);
    }
  });

  it("carries the recalled sections once, in the first round's tail", async () => {
    const requests = await sent("http://127.0.0.1:11434/v1", 4);
    const last = JSON.stringify(requests.at(-1));
    expect(last.split("the user likes tea").length - 1).toBe(1);
  });

  it("leaves a cloud endpoint's request as built: today's digest last, the old ones gone", async () => {
    const requests = await sent("https://api.example.com/v1", 3);
    const last = JSON.stringify(requests.at(-1));
    expect(last).toContain("Turn 3 ·");
    expect(last).not.toContain("Turn 1 ·");
  });
});
