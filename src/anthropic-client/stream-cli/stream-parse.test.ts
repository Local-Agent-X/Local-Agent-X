import { describe, it, expect } from "vitest";
import { processStreamLine, createCliStreamState } from "./stream-parse.js";
import type { StreamEvent } from "../types.js";

function drain(line: string, valid: Set<string>) {
  const state = createCliStreamState();
  const events: StreamEvent[] = [];
  for (const ev of processStreamLine(line, state, valid)) events.push(ev);
  return { events, state };
}

function assistantToolUse(name: string, input: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] },
  });
}

describe("stream-parse — native CLI tools are not re-dispatched", () => {
  const valid = new Set(["web_search", "web_fetch", "bash"]);

  it("native WebSearch yields activity, NOT a tool_call (subprocess-handled)", () => {
    const { events, state } = drain(assistantToolUse("WebSearch", { query: "tokyo" }), valid);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    const activity = events.find((e) => e.type === "mcp_activity");
    expect(activity).toBeDefined();
    expect((activity as { name: string }).name).toBe("WebSearch");
    // Must stay false so the result-event path still parses for genuine LAX
    // tool calls the model may emit as text in the same turn.
    expect(state.emittedNativeTools).toBe(false);
  });

  it("a genuine LAX tool emitted as native tool_use still yields a tool_call", () => {
    const { events, state } = drain(assistantToolUse("web_search", { query: "tokyo" }), valid);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeDefined();
    expect((call as { name: string }).name).toBe("web_search");
    expect(state.emittedNativeTools).toBe(true);
  });

  it("mcp__ tools remain bridge-routed activity (unchanged)", () => {
    const { events } = drain(assistantToolUse("mcp__lax__web_search", { query: "x" }), valid);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "mcp_activity")).toBe(true);
  });
});

describe("stream-parse — stop_reason is carried into the done event", () => {
  const valid = new Set<string>();

  function doneOf(events: StreamEvent[]): StreamEvent | undefined {
    return events.find((e) => e.type === "done");
  }

  it("the top-level `result` frame's stop_reason reaches the done event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "4",
      usage: { input_tokens: 3, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const { events } = drain(line, valid);
    const done = doneOf(events);
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("end_turn");
  });

  it("a `message_delta` stream_event captures stop_reason for a later result frame", () => {
    const state = createCliStreamState();
    const events: StreamEvent[] = [];
    // message_delta carries the stop_reason but yields no event of its own.
    for (const ev of processStreamLine(
      JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } }),
      state,
      valid,
    )) events.push(ev);
    expect(state.stopReason).toBe("tool_use");
    // A trailing result frame WITHOUT its own stop_reason keeps the captured one.
    for (const ev of processStreamLine(JSON.stringify({ type: "result", result: "x" }), state, valid)) events.push(ev);
    expect(doneOf(events)!.stopReason).toBe("tool_use");
  });

  it("done event has undefined stopReason when the CLI never reported one", () => {
    const { events } = drain(JSON.stringify({ type: "result", result: "hi" }), valid);
    expect(doneOf(events)!.stopReason).toBeUndefined();
  });
});
