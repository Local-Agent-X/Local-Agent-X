import { describe, it, expect } from "vitest";
import {
  processCodexEvent,
  flushOnAbnormalClose,
  createCodexStreamState,
  type CodexStreamState,
} from "./stream-parse.js";
import type { CodexStreamEvent, CodexStreamYield } from "./types.js";

async function drain(
  event: CodexStreamEvent,
  state: CodexStreamState,
): Promise<CodexStreamYield[]> {
  const out: CodexStreamYield[] = [];
  for await (const y of processCodexEvent(event, state, "codex-test")) out.push(y);
  return out;
}

async function drainFlush(state: CodexStreamState): Promise<CodexStreamYield[]> {
  const out: CodexStreamYield[] = [];
  for await (const y of flushOnAbnormalClose(state, "codex-test")) out.push(y);
  return out;
}

describe("flushOnAbnormalClose — no double dispatch of live-yielded tool calls", () => {
  it("does NOT re-yield a call that was already dispatched via *.done before the stream dropped", async () => {
    const state = createCodexStreamState();

    // 1. output_item.added captures the tool name + ids
    await drain(
      {
        type: "response.output_item.added",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "email_send" },
      } as unknown as CodexStreamEvent,
      state,
    );

    // 2. args arrive
    await drain(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"to":"a@b.com"}',
      } as unknown as CodexStreamEvent,
      state,
    );

    // 3. args.done yields the tool call LIVE (it is dispatched now)
    const liveYields = await drain(
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        call_id: "call_1",
      } as unknown as CodexStreamEvent,
      state,
    );
    const liveCalls = liveYields.filter((y) => y.type === "tool_call");
    expect(liveCalls).toHaveLength(1);
    expect((liveCalls[0] as { name: string }).name).toBe("email_send");

    // 4. Stream drops (network kill / 120s timeout) before response.completed.
    //    flushOnAbnormalClose must NOT re-yield the same email_send.
    const flushed = await drainFlush(state);
    const flushedCalls = flushed.filter((y) => y.type === "tool_call");
    expect(flushedCalls).toHaveLength(0);
  });

  it("still flushes a genuinely unyielded tool call collected but never finalized", async () => {
    const state = createCodexStreamState();

    await drain(
      {
        type: "response.output_item.added",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "search" },
      } as unknown as CodexStreamEvent,
      state,
    );
    await drain(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_2",
        delta: '{"q":"x"}',
      } as unknown as CodexStreamEvent,
      state,
    );
    // No *.done event — stream drops. Flush should recover this one.
    const flushed = await drainFlush(state);
    const flushedCalls = flushed.filter((y) => y.type === "tool_call");
    expect(flushedCalls).toHaveLength(1);
    expect((flushedCalls[0] as { name: string }).name).toBe("search");
  });
});

// The Responses API ends a reply cut off at the output limit with
// `response.incomplete` (status "incomplete", incomplete_details.reason
// "max_output_tokens"). The parser only knew `response.completed`, so a
// cut-off arrived as an abnormal close with no stop reason, and the turn
// loop's cut-off re-drive could never fire for Codex.
describe("the stop reason the API gave", () => {
  it("a cut-off reply records the incomplete reason and still surfaces its text", async () => {
    const state = createCodexStreamState();
    const out = await drain({
      type: "response.incomplete",
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
      },
    } as unknown as CodexStreamEvent, state);
    expect(state.stopReason).toBe("max_output_tokens");
    expect(state.responseId).toBe("resp_1");
    expect(out.some((y) => y.type === "text" && y.delta === "partial")).toBe(true);
  });

  it("a completed reply records its status", async () => {
    const state = createCodexStreamState();
    await drain({ type: "response.completed", response: { id: "resp_2", status: "completed" } } as unknown as CodexStreamEvent, state);
    expect(state.stopReason).toBe("completed");
  });

  it("a stream with no terminal event has no stop reason", () => {
    expect(createCodexStreamState().stopReason).toBeUndefined();
  });
});
