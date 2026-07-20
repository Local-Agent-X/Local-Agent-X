import { describe, it, expect } from "vitest";
import { createAgentOperation, usageTotalFromEvent } from "./run.js";
import type { CanonicalEvent } from "../types.js";
import type { Op } from "../../ops/types.js";

// Contract of the agent-runner's turn_committed → onEvent usage forward:
// only a turn_committed event with a numeric usage.totalTokens yields a total.
// This is the value the driver keys to its agentId and broadcasts on
// agent-update so the chunk-runner card's token bar ticks up live.

function evt(partial: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    opId: "op_agent_spawn_test",
    seq: 1,
    type: "turn_committed",
    ts: new Date().toISOString(),
    body: null,
    ...partial,
  };
}

describe("usageTotalFromEvent — agent-runner live token forward", () => {
  it("returns the running total from a turn_committed usage body", () => {
    expect(usageTotalFromEvent(evt({ body: { usage: { totalTokens: 1234 } } }))).toBe(1234);
  });

  it("returns 0 for a genuine zero total (does not conflate with missing)", () => {
    expect(usageTotalFromEvent(evt({ body: { usage: { totalTokens: 0 } } }))).toBe(0);
  });

  it("returns null when the total is missing or non-numeric", () => {
    expect(usageTotalFromEvent(evt({ body: { usage: {} } }))).toBeNull();
    expect(usageTotalFromEvent(evt({ body: {} }))).toBeNull();
    expect(usageTotalFromEvent(evt({ body: null }))).toBeNull();
    expect(usageTotalFromEvent(evt({ body: { usage: { totalTokens: "9000" } as unknown as { totalTokens?: number } } }))).toBeNull();
  });

  it("returns null for non-turn_committed events (state_changed, error, tool_*)", () => {
    for (const type of ["state_changed", "error", "tool_finished", "turn_started"] as const) {
      expect(usageTotalFromEvent(evt({ type, body: { usage: { totalTokens: 42 } } }))).toBeNull();
    }
  });
});

describe("agent-runner durable session binding", () => {
  it("stamps the originating session at the top level of every created op", () => {
    const op = createAgentOperation({
      opType: "scheduled_mission",
      userMessage: "continue the durable task",
      contextPack: {} as Op["contextPack"],
      lane: "background",
      sessionId: "session-restart",
    });
    expect(op.sessionId).toBe("session-restart");
  });
});
