import { describe, it, expect } from "vitest";
import { isRetractableHallucination, stripRetractedAssistant } from "./retract-false-claim.js";
import type { CommitTurnMessage } from "../checkpoint.js";

describe("isRetractableHallucination", () => {
  it("retracts a confirmed-false claim about the work that was done", () => {
    // Was "worker-hallucination" / "creation-hallucination" until 2026-09-08.
    // Their middleware (hallucination-check) was deleted in 7d524491 on
    // 2026-07-10 and nothing has emitted those reasons since, so they left the
    // set with these assertions; nudge-reason-coverage.test.ts now fails the
    // build if a classified reason has no emitter.
    expect(isRetractableHallucination("attribution-confabulation")).toBe(true);
    expect(isRetractableHallucination("unsupported-operational-claim")).toBe(true);
  });

  it("retracts a premature 'I can't' the nudge supersedes (capability denial, give-up punt)", () => {
    expect(isRetractableHallucination("tool-search-recovery")).toBe(true);
    expect(isRetractableHallucination("browser-handoff")).toBe(true);
  });

  it("retracts an unverified cleanup done-claim, but not the honest not-done wrap-up", () => {
    expect(isRetractableHallucination("cleanup-verify-false-done")).toBe(true);
    // The plain reason (honest "still remain" wrap-up) must stand.
    expect(isRetractableHallucination("cleanup-verify")).toBe(false);
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
