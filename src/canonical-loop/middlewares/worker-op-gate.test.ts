import { describe, it, expect } from "vitest";
import { isWorkerOp, type CanonicalLoopContext } from "./types.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";

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

describe("nudge middlewares gate on isWorkerOp", () => {
  // These inject stall-nudges that leak into interactive replies / voice, so
  // they're skipped on the interactive lane. mid-turn-stale is intentionally
  // NOT here: its second-strike abort is the circuit-breaker that caps a
  // spinning interactive/voice turn, so it must keep running everywhere.
  const middlewares = [postTurnDetectorMiddleware, prematureCompletionMiddleware];

  for (const mw of middlewares) {
    it(`${mw.name}: off for interactive, on for worker`, () => {
      expect(mw.when?.(ctxWithLane("interactive"))).toBe(false);
      expect(mw.when?.(ctxWithLane("agent"))).toBe(true);
    });
  }
});
