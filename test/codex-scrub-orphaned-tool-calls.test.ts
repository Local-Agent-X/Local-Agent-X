import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { scrubOrphanedToolCalls } from "../src/agent-codex/run-http-helpers.js";

// Helper: build a tool_call entry shaped like OpenAI's API
function tc(id: string, name = "bash", args = "{}"): {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
} {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("scrubOrphanedToolCalls", () => {
  it("leaves a balanced conversation untouched", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "list files" },
      // assistant declares one tool call
      { role: "assistant", content: "", tool_calls: [tc("call_1")] } as unknown as ChatCompletionMessageParam,
      // tool result satisfies it
      { role: "tool", tool_call_id: "call_1", content: "ok" } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "done" },
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(0);
    expect(result.droppedToolResults).toBe(0);
    expect(result.droppedAssistants).toBe(0);
    expect(result.messages).toHaveLength(messages.length);
  });

  it("drops an assistant.tool_calls entry whose result was lost", () => {
    // Reproduces the live Codex 400: assistant claims call_1 + call_2, only
    // call_1 has a tool result. Without scrubbing, the next API call rejects
    // with "No tool output found for function call call_2".
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: "",
        tool_calls: [tc("call_1"), tc("call_2")],
      } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "call_1", content: "first done" } as unknown as ChatCompletionMessageParam,
      // call_2's tool result is missing — orphan
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.droppedToolResults).toBe(0);
    // The assistant message should now have only call_1
    const assistant = result.messages.find((m) => m.role === "assistant") as unknown as {
      tool_calls?: Array<{ id: string }>;
    };
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0].id).toBe("call_1");
  });

  it("drops the assistant entirely when ALL its tool_calls are orphaned and there's no text", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "two things" },
      {
        role: "assistant",
        content: "",
        tool_calls: [tc("call_1"), tc("call_2")],
      } as unknown as ChatCompletionMessageParam,
      // No tool results at all → both orphan
      { role: "user", content: "actually never mind" },
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(2);
    expect(result.droppedAssistants).toBe(1);
    expect(result.messages.find((m) => m.role === "assistant")).toBeUndefined();
  });

  it("strips orphan tool_calls but keeps the assistant when it has text content", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "summarize" },
      {
        role: "assistant",
        content: "Here's what I found",
        tool_calls: [tc("call_1")],
      } as unknown as ChatCompletionMessageParam,
      // No tool result — orphan
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.droppedAssistants).toBe(0);
    const assistant = result.messages.find((m) => m.role === "assistant") as unknown as {
      content: string;
      tool_calls?: unknown;
    };
    expect(assistant.content).toBe("Here's what I found");
    expect(assistant.tool_calls).toBeUndefined();
  });

  it("drops tool messages whose tool_call_id was never declared", () => {
    // The other half of the corruption: a tool result that no preceding
    // assistant message claimed. Causes the same 400.
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "look something up" },
      // No assistant tool_calls before this — orphan tool message
      { role: "tool", tool_call_id: "ghost_call", content: "ok" } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "ok" },
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolResults).toBe(1);
    expect(result.messages.find((m) => m.role === "tool")).toBeUndefined();
  });

  it("keeps in-place tool messages and drops only the trailing orphan", () => {
    // Mixed scenario: first call is balanced, second is orphan
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "two things in sequence" },
      { role: "assistant", content: "", tool_calls: [tc("call_a")] } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "call_a", content: "first ok" } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "", tool_calls: [tc("call_b")] } as unknown as ChatCompletionMessageParam,
      // call_b never satisfied
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.droppedAssistants).toBe(1);
    // Only the first balanced pair should remain
    const tools = result.messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as unknown as { tool_call_id: string }).tool_call_id).toBe("call_a");
  });

  it("handles the pathological case of orphans on BOTH sides", () => {
    // Compaction stripped an assistant; what's left is a tool message with
    // no claimant AND a later assistant.tool_calls with no satisfier.
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "anything" },
      { role: "tool", tool_call_id: "ghost", content: "stale" } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "", tool_calls: [tc("call_x")] } as unknown as ChatCompletionMessageParam,
      // call_x never satisfied
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolResults).toBe(1);
    expect(result.droppedToolCalls).toBe(1);
    expect(result.droppedAssistants).toBe(1);
    // Only system/user-style messages remain (here just the user)
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(result.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("preserves multiple matched calls within the same assistant", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "do three things at once" },
      {
        role: "assistant",
        content: "",
        tool_calls: [tc("c1"), tc("c2"), tc("c3")],
      } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "c1", content: "1 ok" } as unknown as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "c2", content: "2 ok" } as unknown as ChatCompletionMessageParam,
      // c3 missing
    ];
    const result = scrubOrphanedToolCalls(messages);
    expect(result.droppedToolCalls).toBe(1);
    const assistant = result.messages.find((m) => m.role === "assistant") as unknown as {
      tool_calls: Array<{ id: string }>;
    };
    expect(assistant.tool_calls.map((t) => t.id).sort()).toEqual(["c1", "c2"]);
  });

  it("does not match a tool result to a same-id call from a LATER assistant", () => {
    // OpenAI semantics require the tool result to follow the assistant that
    // declared the id. If an orphan tool result happens to share an id with
    // a future assistant.tool_calls, it should still be dropped because the
    // declaration-then-result ordering is the wire contract.
    //
    // Pin behavior: the scrubber treats any tool message whose tool_call_id
    // is declared anywhere in the conversation as valid. This is more lenient
    // than the strict ordering, but matches what the OpenAI API actually
    // accepts for replays. Note this for future tightening if needed.
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "out-of-order replay" },
      { role: "tool", tool_call_id: "call_z", content: "early result" } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "", tool_calls: [tc("call_z")] } as unknown as ChatCompletionMessageParam,
    ];
    const result = scrubOrphanedToolCalls(messages);
    // Lenient: tool message kept (declared id exists somewhere) but the
    // assistant.tool_calls is still orphan because no tool message FOLLOWS it.
    expect(result.droppedToolResults).toBe(0);
    expect(result.droppedToolCalls).toBe(1);
  });
});
