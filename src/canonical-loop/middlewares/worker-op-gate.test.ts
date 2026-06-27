import { describe, it, expect } from "vitest";
import { isWorkerOp, type CanonicalLoopContext } from "./types.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { actionClaimMiddleware } from "./action-claim.js";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { selfCheckMiddleware } from "./self-check.js";
import { postCommitMiddleware } from "./post-commit.js";

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
  // they're skipped on the interactive lane. THREE guards are intentionally NOT
  // here because a spin must be broken on every lane: mid-turn-stale (its
  // second-strike abort caps a spinning interactive/voice turn), loop-detection
  // (runs everywhere, but nudge-only on interactive so it breaks an exact-repeat
  // spin like the grok `ls` loop without hard-killing a turn the user wanted),
  // and dead-end (nudge-only on 3 empty tool results in a row — a genuine spin
  // worth breaking on any lane; the `when` gate was deliberately removed in
  // d2f85ea4 "run the empty-result nudge on interactive chat too", same
  // rationale as loop-detection — see dead-end.ts).
  const middlewares = [
    postTurnDetectorMiddleware,
    prematureCompletionMiddleware,
    actionClaimMiddleware,
    hallucinationCheckMiddleware,
    selfCheckMiddleware,
    postCommitMiddleware,
  ];

  for (const mw of middlewares) {
    it(`${mw.name}: off for interactive, on for worker`, () => {
      expect(mw.when?.(ctxWithLane("interactive"))).toBe(false);
      expect(mw.when?.(ctxWithLane("agent"))).toBe(true);
    });
  }
});
