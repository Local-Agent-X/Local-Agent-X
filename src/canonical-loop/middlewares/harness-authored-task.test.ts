import { describe, it, expect } from "vitest";
import { isHarnessAuthoredTask, isWorkerOp, type CanonicalLoopContext } from "./types.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";

function ctxWithOp(op: Record<string, unknown>): CanonicalLoopContext {
  return makeCanonicalLoopContext({ op });
}

describe("isHarnessAuthoredTask", () => {
  it("is true when the provenance stamp says harness (auto-build chunk worker)", () => {
    expect(isHarnessAuthoredTask(
      ctxWithOp({ type: "agent_spawn", lane: "agent", taskProvenance: "harness" }),
    )).toBe(true);
  });

  it("is true for app_build, whose whole op class predates the provenance stamp", () => {
    expect(isHarnessAuthoredTask(ctxWithOp({ type: "app_build", lane: "build" }))).toBe(true);
  });

  it("is false when no provenance stamp is present (absent = user-authored)", () => {
    expect(isHarnessAuthoredTask(ctxWithOp({ type: "chat_turn", lane: "interactive" }))).toBe(false);
  });

  it("is false for a user-delegated agent_spawn — same op type, human-authored task", () => {
    expect(isHarnessAuthoredTask(ctxWithOp({ type: "agent_spawn", lane: "agent" }))).toBe(false);
  });

  it("is false for voice_turn", () => {
    expect(isHarnessAuthoredTask(ctxWithOp({ type: "voice_turn", lane: "interactive" }))).toBe(false);
  });

  it("explicit provenance 'user' does not flip it", () => {
    expect(isHarnessAuthoredTask(
      ctxWithOp({ type: "agent_spawn", lane: "agent", taskProvenance: "user" }),
    )).toBe(false);
  });

  // The two predicates answer different questions and must never be swapped:
  // a user-delegated agent_spawn is a WORKER op with a HUMAN-authored task.
  it("is independent of isWorkerOp", () => {
    const userDelegated = ctxWithOp({ type: "agent_spawn", lane: "agent" });
    expect(isWorkerOp(userDelegated)).toBe(true);
    expect(isHarnessAuthoredTask(userDelegated)).toBe(false);
  });
});
