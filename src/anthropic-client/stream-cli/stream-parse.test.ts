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
