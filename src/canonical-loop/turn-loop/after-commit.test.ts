import { describe, it, expect, vi, beforeEach } from "vitest";

// guard-fire.ts records banked fires through the real emitter, which appends
// to the op's on-disk event log.
vi.mock("../event-emitter.js", () => ({ emit: vi.fn(), emitErrorOnce: vi.fn(), publishStreamChunk: vi.fn() }));

import { runAfterCommit, type CommittedTurn } from "./after-commit.js";
import { emit } from "../event-emitter.js";
import type { Op } from "../../ops/types.js";
import type { CanonicalEvent } from "../types.js";

const op = { id: "op-after-commit" } as unknown as Op;

function makeDeps() {
  return {
    requestSkillReviewForOp: vi.fn(),
    snapshotTouchedApps: vi.fn(async () => {}),
    appendNudgeAsUserMessage: vi.fn(() => true),
    recoverCommittedStrategyPivot: vi.fn(() => false),
    emitErrorOnce: vi.fn(() => ({ seq: 1 }) as unknown as CanonicalEvent),
  };
}

function turn(over: Partial<CommittedTurn> = {}): CommittedTurn {
  return { op, turnIdx: 5, learningSessionId: null, toolCalls: [], earnedFires: [], directive: null, ...over };
}

beforeEach(() => vi.clearAllMocks());

describe("runAfterCommit", () => {
  it("runs review, snapshot, earned fires and directive in that order", () => {
    const deps = makeDeps();
    const toolCalls = [{ toolCallId: "c1", tool: "write_file", args: {} }];
    runAfterCommit(turn({
      learningSessionId: "s1",
      toolCalls,
      earnedFires: [{ name: "build-verify", reason: "verified-clean", outcome: "honest-terminal" }],
      directive: { kind: "nudge", reason: "r", firedBy: "open-steps", message: "next" },
    }), deps);

    expect(deps.requestSkillReviewForOp).toHaveBeenCalledWith(op, "s1", 5);
    expect(deps.snapshotTouchedApps).toHaveBeenCalledWith(toolCalls, 5);
    expect(emit).toHaveBeenCalledWith(op.id, "middleware_fired", { name: "build-verify", reason: "verified-clean", outcome: "honest-terminal", turnIdx: 5 });
    expect(deps.appendNudgeAsUserMessage).toHaveBeenCalledWith(op.id, 6, "next", { name: "open-steps", reason: "r", outcome: "nudge" }, undefined);

    const order = [
      deps.requestSkillReviewForOp.mock.invocationCallOrder[0],
      deps.snapshotTouchedApps.mock.invocationCallOrder[0],
      vi.mocked(emit).mock.invocationCallOrder[0],
      deps.appendNudgeAsUserMessage.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("asks for no skill review without a terminal outcome's learning session", () => {
    const deps = makeDeps();
    runAfterCommit(turn(), deps);
    expect(deps.requestSkillReviewForOp).not.toHaveBeenCalled();
    expect(deps.snapshotTouchedApps).toHaveBeenCalledTimes(1);
  });

  it("applies an abort through the injected emitErrorOnce, and nothing without a directive", () => {
    const deps = makeDeps();
    runAfterCommit(turn(), deps);
    expect(deps.emitErrorOnce).not.toHaveBeenCalled();
    expect(deps.appendNudgeAsUserMessage).not.toHaveBeenCalled();

    runAfterCommit(turn({ directive: { kind: "abort", reason: "r", firedBy: "loop-detection", message: "stop" } }), deps);
    expect(deps.emitErrorOnce).toHaveBeenCalledWith(op.id, { code: "middleware-abort", message: "stop", retryable: false });
  });
});
