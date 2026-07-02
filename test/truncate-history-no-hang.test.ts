import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { truncateHistory } from "../src/providers/sanitize.js";

// Regression for the empty `while` loop in truncateHistory that spun forever.
//
// Reproduces a long agentic tail: one leading `user` message, then a run of
// assistant(tool_calls)/tool(tool_result) pairs INCLUDING a parallel-call block
// (assistant with 2 tool_calls followed by 2 tool_result rows) positioned so the
// maxKeep=30 cut lands on the FIRST tool_result of that block. With 50 messages,
// targetIdx = 50 - 30 = 20 (the first parallel tool_result) and the last 30
// messages contain no `user` row — the exact condition that backed cutIdx onto
// the parallel assistant (index 19) and then hit the empty `while` that never
// mutated cutIdx/body, hanging the single-threaded server.
function buildAgenticHistory(): ChatCompletionMessageParam[] {
  const asst = (id: string): ChatCompletionMessageParam =>
    ({
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: "do_thing", arguments: "{}" } }],
    } as ChatCompletionMessageParam);
  const tool = (id: string): ChatCompletionMessageParam =>
    ({ role: "tool", tool_call_id: id, content: "ok" } as ChatCompletionMessageParam);

  const msgs: ChatCompletionMessageParam[] = [];
  msgs.push({ role: "user", content: "kick off the long job" }); // index 0

  // indices 1..18 — nine single-call assistant/tool pairs
  for (let i = 0; i < 9; i++) {
    msgs.push(asst(`call_${i}`));
    msgs.push(tool(`call_${i}`));
  }

  // index 19 — parallel block: assistant with 2 tool_calls
  msgs.push({
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call_p1", type: "function", function: { name: "a", arguments: "{}" } },
      { id: "call_p2", type: "function", function: { name: "b", arguments: "{}" } },
    ],
  } as ChatCompletionMessageParam);
  msgs.push(tool("call_p1")); // index 20 — cut lands here (targetIdx = 20)
  msgs.push(tool("call_p2")); // index 21

  // indices 22..49 — fourteen more single-call pairs
  for (let i = 9; i < 23; i++) {
    msgs.push(asst(`call_${i}`));
    msgs.push(tool(`call_${i}`));
  }

  return msgs;
}

describe("truncateHistory — parallel-tail cut must terminate", () => {
  // Tight per-test timeout: on the old code this call never returns.
  it("returns instead of hanging when the cut lands on a parallel tool_result", () => {
    const history = buildAgenticHistory();
    expect(history.length).toBe(50);
    // Preconditions that force the buggy path: no `user` in the last maxKeep=30
    // rows, and the cut index (20) is a tool_result preceded by an
    // assistant-with-tool_calls (19).
    expect(history.slice(history.length - 30).some((m) => m.role === "user")).toBe(false);
    expect(history[20]?.role).toBe("tool");
    expect(history[19]?.role).toBe("assistant");

    const out = truncateHistory(history, 30);

    // 1. It returned at all (old code spun the empty `while` forever here).
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);

    // 2. Return contract preserved: leading auto-summary system row + kept tail.
    expect(out[0]?.role).toBe("system");
    const recent = out.slice(1);
    expect(recent.length).toBeGreaterThan(0);

    // 3. Pairing invariant: the kept tail must NOT begin with an orphaned
    //    tool_result. cutIdx was backed onto the parallel assistant, so the
    //    first recent row is that assistant-with-tool_calls, never a bare tool.
    const head = recent[0] as { role: string; tool_calls?: unknown };
    expect(head.role).not.toBe("tool");
    expect(head.role).toBe("assistant");
    expect(Array.isArray(head.tool_calls)).toBe(true);

    // 4. Stronger pairing check: every tool_result in the tail has its matching
    //    assistant tool_call present earlier in the tail — no orphan leaked in.
    const seenCallIds = new Set<string>();
    for (const m of recent) {
      const rec = m as { role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string };
      if (rec.role === "assistant" && rec.tool_calls) {
        for (const tc of rec.tool_calls) seenCallIds.add(tc.id);
      }
      if (rec.role === "tool" && rec.tool_call_id) {
        expect(seenCallIds.has(rec.tool_call_id)).toBe(true);
      }
    }
  }, 3000);
});
