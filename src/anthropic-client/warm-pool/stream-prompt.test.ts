import { describe, it, expect } from "vitest";
import { processFrame, type FrameContext } from "./stream-prompt.js";
import type { StreamEvent } from "../types.js";

// Build a closure-backed FrameContext like streamViaWarmPool's inner loop does,
// so the stop_reason capture (set on a stream_event/result, read when the done
// event is built) round-trips exactly as it does in production.
function makeCtx(over: Partial<FrameContext> = {}): FrameContext {
  let stop: string | undefined;
  let full = "";
  return {
    getAborted: () => false,
    getFullText: () => full,
    appendText: (t) => { full += t; },
    setUsage: () => {},
    getStopReason: () => stop,
    setStopReason: (s) => { stop = s; },
    ...over,
  };
}

function drain(frames: Record<string, unknown>[], ctx: FrameContext): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const f of frames) for (const ev of processFrame(f, ctx)) events.push(ev);
  return events;
}

const doneOf = (events: StreamEvent[]) => events.find((e) => e.type === "done");

describe("warm-pool processFrame — stop_reason is carried into the done event", () => {
  it("the result frame's top-level stop_reason reaches the done event", () => {
    const events = drain(
      [{ type: "result", result: "4", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }],
      makeCtx(),
    );
    expect(doneOf(events)!.stopReason).toBe("end_turn");
  });

  it("a message_delta frame captures stop_reason for the later result frame", () => {
    const ctx = makeCtx();
    const events = drain(
      [
        { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
        { type: "result", result: "x" },
      ],
      ctx,
    );
    expect(ctx.getStopReason()).toBe("tool_use");
    expect(doneOf(events)!.stopReason).toBe("tool_use");
  });

  it("done event has undefined stopReason when the CLI never reported one", () => {
    const events = drain([{ type: "result", result: "hi" }], makeCtx());
    expect(doneOf(events)!.stopReason).toBeUndefined();
  });
});

describe("warm-pool processFrame — tool routing (unchanged)", () => {
  const assistantToolUse = (name: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name, input: { q: "x" } }] },
  });

  it("a non-MCP tool_use yields a tool_call the outer loop dispatches", () => {
    const events = drain([assistantToolUse("web_search")], makeCtx());
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeDefined();
    expect((call as { name: string }).name).toBe("web_search");
  });

  it("an mcp__ tool_use stays bridge-routed activity, not a tool_call", () => {
    const events = drain([assistantToolUse("mcp__lax__web_search")], makeCtx());
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "mcp_activity")).toBe(true);
  });
});
