/**
 * Middleware registry — assembles the ordered stack used by
 * runAgentTurn. Order MATTERS: ceiling checks fire before subagent
 * drain (don't waste a drain if we're about to abort), heartbeat
 * fires last in beforeIteration so it only starts on iter 0 if
 * nothing has aborted yet.
 *
 * Phase 1: only the 5 universal "infrastructure" middlewares are
 * registered. Behavior middlewares (post-turn detectors, hallucination
 * checks, etc.) are added in Phase 2 as they're ported from the legacy
 * loops.
 *
 * Provider-specific middlewares (e.g. autoBuildAppMiddleware for
 * Anthropic) check `req.provider` in their `when` predicate, so
 * registration is uniform.
 */

import type { LoopMiddleware } from "./types.js";
import { tokenCeilingMiddleware } from "./middlewares/token-ceiling.js";
import { wallClockCeilingMiddleware } from "./middlewares/wall-clock-ceiling.js";
import { midTurnStaleMiddleware } from "./middlewares/mid-turn-stale.js";
import { subagentDrainMiddleware } from "./middlewares/subagent-drain.js";
import { heartbeatMiddleware } from "./middlewares/heartbeat.js";
import { forceToolUseMiddleware } from "./middlewares/force-tool-use.js";
import { pauseMiddleware } from "./middlewares/pause.js";
import { postCommitMiddleware } from "./middlewares/post-commit.js";
import { deadEndMiddleware } from "./middlewares/dead-end.js";
import { selfCheckMiddleware } from "./middlewares/self-check.js";
import { postTurnDetectorMiddleware } from "./middlewares/post-turn-detector.js";
import { hallucinationCheckMiddleware } from "./middlewares/hallucination-check.js";
import { actionClaimMiddleware } from "./middlewares/action-claim.js";
import { loopDetectionMiddleware } from "./middlewares/loop-detection.js";
import { autoBuildAppMiddleware } from "./middlewares/auto-build-app.js";

export function getDefaultMiddlewareStack(): LoopMiddleware[] {
  return [
    // ── beforeIteration ──
    // Ceilings first — abort cheap before doing other work.
    tokenCeilingMiddleware,
    wallClockCeilingMiddleware,
    midTurnStaleMiddleware,
    // Then drain inbound subagent completions (push them into messages).
    subagentDrainMiddleware,
    // Set toolChoice for build/action intents on iter 0.
    forceToolUseMiddleware,
    // Heartbeat last — only meaningful if we're actually going to run.
    heartbeatMiddleware,

    // ── afterModelCall ──
    // pause first (preempts every other end-of-turn path).
    pauseMiddleware,
    // post-turn detector stack — sets prompt-layer retry nudges, fires
    // retry-iteration so the next iteration's recomposed system prompt
    // carries the correction. Runs BEFORE the no-tool-call branch so
    // detector wins over hallucination-style nudges.
    postTurnDetectorMiddleware,
    // Anthropic-only: synthesize a build_app tool call when the model
    // emitted build-intent text but didn't actually invoke build_app.
    // Mutates result.toolCalls so the loop's later branch executes it.
    autoBuildAppMiddleware,
    // Hallucination guards — fire only when no tool calls. Approval
    // first (more specific), creation second (iter 0 only).
    hallucinationCheckMiddleware,
    // Action-claim verification — once per turn, terminal turns only.
    actionClaimMiddleware,
    // Self-check — once per turn, scans for unresolved tool errors and
    // injects a reflection prompt.
    selfCheckMiddleware,
    // Loop detection — checks tool-call repetition, can abort.
    loopDetectionMiddleware,

    // ── afterToolExecution ──
    // dead-end FIRST so an empty result in this iteration nudges before
    // the post-commit wrap-up gets a chance.
    deadEndMiddleware,
    postCommitMiddleware,
  ];
}
