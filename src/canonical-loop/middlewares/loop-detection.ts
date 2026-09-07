/**
 * Tool-loop detector — checkToolLoops with model-tier-aware thresholds.
 * Canonical-loop port of src/agent-loop/middlewares/loop-detection.ts.
 *
 * Fires in afterModelCall so it sees this turn's tool calls before dispatch.
 * State is per-op so the lastToolKey / sameToolCount carry across turns.
 *
 * Lane policy. Interactive runs nudge-only: a runaway spin must be broken,
 * but a legitimate repeated call the user wants must never have its turn
 * hard-killed; the guard's own NUDGE_CEILING ends a turn that ignores six
 * nudges. Worker lanes (build / background / ide) never abort from the guard:
 * every abort path is deferred and the worker is offered an autonomous
 * strategy pivot instead — bounded by the pivot ceiling in strategy-pivot.ts,
 * which ends the op once all four strategies have been offered against a
 * detected CYCLE with no novel result since the first. Exact-repeat and
 * no-progress pivots (a poll, a 429 retry) are offered but never counted.
 * Before that ceiling the only brake on a stuck worker was the wall clock.
 */
import { type CanonicalMiddleware, type CanonicalMiddlewareResult, type CanonicalLoopContext } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkToolLoops,
  hasSeenSuccessfulCommittingCall,
  noteToolResults,
  createLoopState,
  type LoopState,
} from "../../agent-guards/index.js";
import {
  createPivotCeilingState,
  notePivotEvidence,
  PIVOT_CEILING_KEY,
  restorePersistedPivot,
  workerStrategyPivot,
  type AutonomousPivotPattern,
  type PivotCeilingState,
  type PivotOrigin,
} from "./strategy-pivot.js";

function toLoopCalls(toolCalls: { tool: string; args: unknown }[]): { name: string; arguments: string }[] {
  return toolCalls.map(tc => ({
    name: tc.tool,
    arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
  }));
}

/** Take the pending pivot off the guard state; returns who armed it. */
function consumePivot(state: LoopState): PivotOrigin {
  const origin: PivotOrigin = { fromCycle: state.pendingPivotFromCycle };
  state.pendingStrategyPivot = null;
  state.pendingPivotFromCycle = false;
  state.identicalResultRepeats = 0;
  state.iterationsSinceProgress = 0;
  for (const name of state.toolNameCounts.keys()) state.toolNameCounts.set(name, 0);
  return origin;
}

function ceilingFor(ctx: CanonicalLoopContext): PivotCeilingState {
  return getMiddlewareState<PivotCeilingState>(ctx.op.id, PIVOT_CEILING_KEY, createPivotCeilingState);
}

/** The worker's next strategy, or the ceiling abort — one pivot per turn. */
function offerPivot(ctx: CanonicalLoopContext, pattern: AutonomousPivotPattern, origin: PivotOrigin): CanonicalMiddlewareResult {
  return workerStrategyPivot(ctx, ceilingFor(ctx), pattern, origin);
}
/** mutation-repeat is detected pre-dispatch by the middleware itself, never by the cycle detector. */
const NOT_CYCLE: PivotOrigin = { fromCycle: false };

export const loopDetectionMiddleware: CanonicalMiddleware = {
  name: "loop-detection",

  beforeTurn(ctx) {
    if (ctx.op.lane === "interactive") return { kind: "continue" };
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    if (restorePersistedPivot(ctx)) {
      consumePivot(state);
      return { kind: "continue" };
    }
    const pattern = state.pendingStrategyPivot;
    if (!pattern) return { kind: "continue" };
    return offerPivot(ctx, pattern, consumePivot(state));
  },

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const { loopGuardTier } = await import("../../model-tiers.js");
    const modelTier = loopGuardTier(ctx.model);
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const loopCalls = toLoopCalls(ctx.toolCalls);
    if (ctx.op.lane !== "interactive" && hasSeenSuccessfulCommittingCall(loopCalls, state)) {
      const pivot = offerPivot(ctx, "mutation-repeat", NOT_CYCLE);
      ctx.toolCalls.length = 0;
      return pivot.kind === "nudge" ? { ...pivot, skipToolDispatch: true } : pivot;
    }
    const nudgeOnly = ctx.op.lane === "interactive";
    const r = checkToolLoops(loopCalls, state, {
      modelTier,
      nudgeOnly,
      deferWorkerPivot: !nudgeOnly,
    });
    if (r.abort) {
      ctx.onEvent?.({ type: "stream", delta: r.nudge || "" });
      return { kind: "abort", reason: "loop-detection", message: r.nudge || undefined };
    }
    if (r.nudge) {
      return { kind: "nudge", message: r.nudge, reason: "loop-detection" };
    }
    // A deferred cycle (the multi-turn circle exact-repeat cannot see) arms a
    // pivot in checkToolLoops; offer it now, before this turn's tools run —
    // the post-dispatch path below would drop it on a write turn, because a
    // fresh mutation target clears the pending pivot as "progress". This is
    // the one site whose pivots advance the ceiling (pendingPivotFromCycle).
    if (!nudgeOnly && state.pendingStrategyPivot) {
      const pattern = state.pendingStrategyPivot;
      return offerPivot(ctx, pattern, consumePivot(state));
    }
    return { kind: "continue" };
  },

  // Record this turn's results so exact-repeat can distinguish a stuck spin
  // (same call, same result) from legitimate repetition (same call, changing
  // result — user-requested batches, polling, progressing retries).
  async afterToolExecution(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const { loopGuardTier } = await import("../../model-tiers.js");
    const observation = noteToolResults(toLoopCalls(ctx.toolCalls), state, ctx.toolResults, {
      modelTier: loopGuardTier(ctx.model),
      armWorkerPivot: ctx.op.lane !== "interactive",
    });
    if (ctx.op.lane === "interactive") return { kind: "continue" };
    const ceiling = ceilingFor(ctx);
    notePivotEvidence(ceiling, observation.novel);
    if (observation.pendingPivot && ceiling.lastPivotTurn !== ctx.turnIdx) {
      const pattern = observation.pendingPivot;
      return workerStrategyPivot(ctx, ceiling, pattern, consumePivot(state));
    }
    return { kind: "continue" };
  },
};
