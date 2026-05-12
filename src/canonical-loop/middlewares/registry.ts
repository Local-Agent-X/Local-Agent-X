/**
 * Default canonical-loop middleware stack.
 *
 * Order matters — copied from the universal-coverage order documented in
 * docs/runagent-caller-inventory.md "Legacy-loop middleware coverage" so the
 * canonical safety stack fires in the same sequence the three legacy loops
 * use:
 *
 *   beforeTurn:           mid-turn-stale, force-tool-use (codex)
 *   afterModelCall:       loop-detection, hallucination-check, action-claim,
 *                         self-check, post-turn-detector, auto-build-app
 *                         (anthropic, runs AFTER post-turn-detector so the
 *                         detector sees the original empty-toolCalls state
 *                         before auto-build mutates it)
 *   afterToolExecution:   post-commit, dead-end
 *
 * Each middleware's `when` predicate gates per-provider extras at registration
 * walk time — `when:false` middlewares are skipped on every hook.
 */
import type { CanonicalMiddleware } from "./types.js";
import { loopDetectionMiddleware } from "./loop-detection.js";
import { deadEndMiddleware } from "./dead-end.js";
import { postCommitMiddleware } from "./post-commit.js";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { actionClaimMiddleware } from "./action-claim.js";
import { selfCheckMiddleware } from "./self-check.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { forceToolUseMiddleware } from "./force-tool-use.js";
import { autoBuildAppMiddleware } from "./auto-build-app.js";

export function getDefaultMiddlewareStack(): CanonicalMiddleware[] {
  return [
    midTurnStaleMiddleware,
    forceToolUseMiddleware,
    loopDetectionMiddleware,
    hallucinationCheckMiddleware,
    actionClaimMiddleware,
    selfCheckMiddleware,
    postTurnDetectorMiddleware,
    autoBuildAppMiddleware,
    postCommitMiddleware,
    deadEndMiddleware,
  ];
}
