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

export function getDefaultMiddlewareStack(): LoopMiddleware[] {
  return [
    // Ceilings first — abort cheap before doing other work.
    tokenCeilingMiddleware,
    wallClockCeilingMiddleware,
    midTurnStaleMiddleware,
    // Then drain inbound subagent completions (push them into messages).
    subagentDrainMiddleware,
    // Heartbeat last — only meaningful if we're actually going to run.
    heartbeatMiddleware,
  ];
}
