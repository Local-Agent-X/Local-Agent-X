import { describe, it, expect } from "vitest";
import { convertMessages } from "./request.js";
import { encodeToolCallId } from "../codex-message-convert.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// Live failure 2026-09-08: a session that had run on Codex was switched to
// claude-opus-5 and every turn died with
//   messages.3.content.0.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'
// The bad id stays in the history, so the conversation is wedged permanently —
// even a bare "yo" replays it.
const ANTHROPIC_ID = /^[a-zA-Z0-9_-]+$/;

function turn(id: string): ChatCompletionMessageParam[] {
  return [
    { role: "user", content: "push to vercel" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
    } as unknown as ChatCompletionMessageParam,
    { role: "tool", tool_call_id: id, content: "ok" } as unknown as ChatCompletionMessageParam,
  ];
}

function toolUseIds(msgs: ReturnType<typeof convertMessages>): string[] {
  return msgs.flatMap((m) =>
    (Array.isArray(m.content) ? m.content : []).flatMap((c) => {
      const block = c as { type: string; id?: string; tool_use_id?: string };
      if (block.type === "tool_use") return [block.id as string];
      if (block.type === "tool_result") return [block.tool_use_id as string];
      return [];
    }),
  );
}

describe("tool_use ids from another provider", () => {
  it("maps a Codex composite id into Anthropic's alphabet", () => {
    const codexId = encodeToolCallId("call_qnnbHlRX7aHF5E1FBy8Ifyu6", "fc_028568243b802598016a9f7af3571c87");
    expect(codexId).toContain("|");

    const ids = toolUseIds(convertMessages(turn(codexId)));
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(ANTHROPIC_ID);
  });

  it("keeps the tool_result pointing at its tool_use", () => {
    const ids = toolUseIds(convertMessages(turn(encodeToolCallId("call_abc", "fc_def"))));
    expect(ids[0]).toBe(ids[1]);
  });

  it("is stable across replays, so the cache prefix does not move", () => {
    const msgs = turn(encodeToolCallId("call_abc", "fc_def"));
    expect(toolUseIds(convertMessages(msgs))).toEqual(toolUseIds(convertMessages(msgs)));
  });

  it("leaves an id that is already legal untouched", () => {
    const ids = toolUseIds(convertMessages(turn("toolu_01ABCdef-xyz_9")));
    expect(ids).toEqual(["toolu_01ABCdef-xyz_9", "toolu_01ABCdef-xyz_9"]);
  });

  it("still separates two calls that sanitize to the same id", () => {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a|fc_1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "call_a:fc_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "call_a|fc_1", content: "first" } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "call_a:fc_1", content: "second" } as unknown as ChatCompletionMessageParam,
    ];
    const ids = toolUseIds(convertMessages(msgs));
    for (const id of ids) expect(id).toMatch(ANTHROPIC_ID);
    expect(new Set(ids.slice(0, 2)).size).toBe(2);
  });
});
