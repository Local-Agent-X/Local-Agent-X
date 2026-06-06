import { describe, it, expect } from "vitest";
import { isWorkerOp, type CanonicalLoopContext } from "./types.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";

function ctxWithLane(lane: string): CanonicalLoopContext {
  return { op: { lane } } as unknown as CanonicalLoopContext;
}

describe("isWorkerOp", () => {
  it("is false for interactive turns (chat + voice share the interactive lane)", () => {
    expect(isWorkerOp(ctxWithLane("interactive"))).toBe(false);
  });

  it("is true for autonomous worker lanes", () => {
    for (const lane of ["agent", "build", "background"]) {
      expect(isWorkerOp(ctxWithLane(lane))).toBe(true);
    }
  });
});

describe("worker-progress middlewares gate on isWorkerOp", () => {
  // All three inject stall-nudges that leak into interactive replies / voice;
  // each must be skipped on the interactive lane and run on worker lanes.
  const middlewares = [
    postTurnDetectorMiddleware,
    prematureCompletionMiddleware,
    midTurnStaleMiddleware,
  ];

  for (const mw of middlewares) {
    it(`${mw.name}: off for interactive, on for worker`, () => {
      expect(mw.when?.(ctxWithLane("interactive"))).toBe(false);
      expect(mw.when?.(ctxWithLane("agent"))).toBe(true);
    });
  }
});
