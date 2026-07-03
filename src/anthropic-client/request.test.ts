import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

import { convertMessages } from "./request.js";
import type { AnthropicContent } from "./types.js";

function assistantWithCall(id: string, name = "read_file"): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      { id, type: "function", function: { name, arguments: '{"path":"a.txt"}' } },
    ],
  } as ChatCompletionMessageParam;
}

function toolResult(id: string, content = "ok"): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content } as ChatCompletionMessageParam;
}

function collectBlocks(result: ReturnType<typeof convertMessages>) {
  const toolUses: Array<{ id: string }> = [];
  const toolResults: Array<{ tool_use_id: string }> = [];
  for (const msg of result) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content as AnthropicContent[]) {
      const b = block as unknown as Record<string, unknown>;
      if (b.type === "tool_use") toolUses.push({ id: b.id as string });
      if (b.type === "tool_result") toolResults.push({ tool_use_id: b.tool_use_id as string });
    }
  }
  return { toolUses, toolResults };
}

/** Every tool_result must reference exactly one tool_use, and ids must be unique. */
function expectValidPairing(result: ReturnType<typeof convertMessages>): void {
  const { toolUses, toolResults } = collectBlocks(result);
  const useIds = toolUses.map((t) => t.id);
  expect(new Set(useIds).size).toBe(useIds.length); // no duplicate tool_use ids
  const remaining = [...useIds];
  for (const r of toolResults) {
    const idx = remaining.indexOf(r.tool_use_id);
    expect(idx, `tool_result ${r.tool_use_id} has no unclaimed matching tool_use`).not.toBe(-1);
    remaining.splice(idx, 1); // each tool_use claimed at most once
  }
}

describe("convertMessages tool_use id dedup keeps tool_result pairing intact", () => {
  it("renames the duplicate's tool_result to match the renamed tool_use (session replay)", () => {
    // Replayed history: the same tool_call id appears in two assistant turns.
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      assistantWithCall("call_dup"),
      toolResult("call_dup", "first result"),
      assistantWithCall("call_dup"),
      toolResult("call_dup", "second result"),
    ];

    const result = convertMessages(messages);
    const { toolUses, toolResults } = collectBlocks(result);

    expect(toolUses).toHaveLength(2);
    expect(toolResults).toHaveLength(2);

    // First pair keeps the original id.
    expect(toolUses[0].id).toBe("call_dup");
    expect(toolResults[0].tool_use_id).toBe("call_dup");

    // Second tool_use was renamed — its tool_result must carry the SAME renamed id,
    // not the original (which would orphan the renamed tool_use and double-answer
    // the original).
    expect(toolUses[1].id).not.toBe("call_dup");
    expect(toolResults[1].tool_use_id).toBe(toolUses[1].id);

    expectValidPairing(result);
  });

  it("pairs in order when the same id is duplicated inside one assistant message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call_x", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      } as ChatCompletionMessageParam,
      toolResult("call_x", "for first"),
      toolResult("call_x", "for second"),
    ];

    const result = convertMessages(messages);
    const { toolUses, toolResults } = collectBlocks(result);

    expect(toolUses).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].tool_use_id).toBe(toolUses[0].id);
    expect(toolResults[1].tool_use_id).toBe(toolUses[1].id);
    expectValidPairing(result);
  });

  it("leaves non-duplicated ids untouched", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      assistantWithCall("call_a"),
      toolResult("call_a"),
      assistantWithCall("call_b"),
      toolResult("call_b"),
    ];

    const result = convertMessages(messages);
    const { toolUses, toolResults } = collectBlocks(result);

    expect(toolUses.map((t) => t.id)).toEqual(["call_a", "call_b"]);
    expect(toolResults.map((r) => r.tool_use_id)).toEqual(["call_a", "call_b"]);
  });

  it("passes through a tool_result whose id was never seen on the assistant side", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      toolResult("call_orphan", "stray"),
    ];

    const result = convertMessages(messages);
    const { toolResults } = collectBlocks(result);
    expect(toolResults).toEqual([{ tool_use_id: "call_orphan" }]);
  });
});
