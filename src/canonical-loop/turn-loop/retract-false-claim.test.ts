import { describe, it, expect } from "vitest";
import { isRetractableHallucination, stripRetractedAssistant } from "./retract-false-claim.js";
import type { CommitTurnMessage } from "../checkpoint.js";

describe("isRetractableHallucination", () => {
  it("retracts confirmed-false work claims", () => {
    expect(isRetractableHallucination("worker-hallucination")).toBe(true);
    expect(isRetractableHallucination("creation-hallucination")).toBe(true);
  });

  it("does not retract a misplaced permission ask", () => {
    // "requires approval" is wrong but not a false claim of completed work —
    // its text should stand and the model is nudged to just call the tool.
    expect(isRetractableHallucination("approval-hallucination")).toBe(false);
  });

  it("does not retract ordinary continuation nudges", () => {
    expect(isRetractableHallucination("uncommitted-turn")).toBe(false);
    expect(isRetractableHallucination("planning-only")).toBe(false);
    expect(isRetractableHallucination(undefined)).toBe(false);
    expect(isRetractableHallucination(null)).toBe(false);
  });
});

describe("stripRetractedAssistant", () => {
  const assistant: CommitTurnMessage = {
    messageId: "m1",
    role: "assistant",
    content: { text: "Worker already on it, build running in the background." },
  };
  const tool: CommitTurnMessage = {
    messageId: "m2",
    role: "tool_result",
    content: { toolCallId: "c1", result: "ok" },
  };

  it("drops the false assistant claim", () => {
    expect(stripRetractedAssistant([assistant])).toEqual([]);
  });

  it("preserves tool messages if the turn ever carries any", () => {
    expect(stripRetractedAssistant([assistant, tool])).toEqual([tool]);
  });

  it("is a no-op when there is nothing to strip", () => {
    expect(stripRetractedAssistant([tool])).toEqual([tool]);
    expect(stripRetractedAssistant([])).toEqual([]);
  });
});
