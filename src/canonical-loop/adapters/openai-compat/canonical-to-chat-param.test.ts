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
