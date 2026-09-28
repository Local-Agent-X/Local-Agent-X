// The history rebuild for the OpenAI-shaped wire: an assistant row that
// carries tool calls is sent with its text too, unless the model's runtime
// template would then drop the calls (Ollama's legacy Qwen3 template renders
// `{{ if .Content }}…{{ else if .ToolCalls }}`), in which case the preamble
// text is left out and the calls survive.
import { describe, it, expect } from "vitest";
import { canonicalToChatParam } from "./canonical-to-chat-param.js";
import type { CanonicalMessage } from "../../contract-types.js";

const call = { id: "t1", name: "read", arguments: "{\"path\":\"a.txt\"}" };
const history: CanonicalMessage[] = [
  { messageId: "u1", role: "user", content: { text: "read a.txt" } },
  { messageId: "a1", role: "assistant", content: { text: "Let me look.", toolCalls: [call] } },
  { messageId: "r1", role: "tool_result", content: { toolCallId: "t1", result: "hello" } },
  { messageId: "a2", role: "assistant", content: { text: "It says hello." } },
];

describe("canonicalToChatParam — assistant rows with tool calls", () => {
  it("sends text and tool calls together by default", () => {
    const out = canonicalToChatParam(history, undefined, new Set(["read"]));
    const row = out[1] as { content: string; tool_calls?: unknown[] };
    expect(row.content).toBe("Let me look.");
    expect(row.tool_calls).toHaveLength(1);
    expect((out[3] as { content: string }).content).toBe("It says hello.");
  });

  it("leaves the preamble out of a tool-call row for a text-or-tool-calls runtime, keeping the calls", () => {
    const out = canonicalToChatParam(history, undefined, new Set(["read"]), "text-or-tool-calls");
    const row = out[1] as { content: string; tool_calls?: Array<{ function: { name: string } }> };
    expect(row.content).toBe("");
    expect(row.tool_calls?.map((t) => t.function.name)).toEqual(["read"]);
    // A plain text row is untouched.
    expect((out[3] as { content: string }).content).toBe("It says hello.");
  });
});

// Reasoning replay: each assistant row's own reasoning rides back on the rows
// of the CURRENT tool loop (after the last user row), where the Qwen templates
// render a prior <think>; rows before the last user row never carry it. A
// preamble dropped from the content by text-or-tool-calls goes there too.
describe("canonicalToChatParam — reasoning replay", () => {
  const loop: CanonicalMessage[] = [
    { messageId: "u0", role: "user", content: { text: "earlier ask" } },
    { messageId: "a0", role: "assistant", content: { text: "earlier answer", reasoning: "old thoughts" } },
    { messageId: "u1", role: "user", content: { text: "read a.txt" } },
    { messageId: "a1", role: "assistant", content: { text: "Let me look.", toolCalls: [call], reasoning: "I should read the file first." } },
    { messageId: "r1", role: "tool_result", content: { toolCallId: "t1", result: "hello" } },
    { messageId: "a2", role: "assistant", content: { text: "It says hello.", reasoning: "That answers it." } },
  ];
  const reasoningOf = (row: unknown) => (row as { reasoning?: string }).reasoning;

  it("is off by default: no row carries reasoning", () => {
    const out = canonicalToChatParam(loop, undefined, new Set(["read"]));
    expect(out.every((row) => reasoningOf(row) === undefined)).toBe(true);
  });

  it("sends reasoning only on the assistant rows after the last user row", () => {
    const out = canonicalToChatParam(loop, undefined, new Set(["read"]), "text-and-tool-calls", true);
    expect(reasoningOf(out[1])).toBeUndefined();
    expect(reasoningOf(out[3])).toBe("I should read the file first.");
    expect((out[3] as { content: string }).content).toBe("Let me look.");
    expect(reasoningOf(out[5])).toBe("That answers it.");
  });

  it("folds a preamble dropped by text-or-tool-calls into the row's reasoning", () => {
    const out = canonicalToChatParam(loop, undefined, new Set(["read"]), "text-or-tool-calls", true);
    expect((out[3] as { content: string }).content).toBe("");
    expect(reasoningOf(out[3])).toBe("I should read the file first.\n\nLet me look.");
  });
});
