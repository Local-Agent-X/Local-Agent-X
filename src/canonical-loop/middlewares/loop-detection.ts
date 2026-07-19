/**
 * Tool-loop detector — checkToolLoops with model-tier-aware thresholds.
 * Canonical-loop port of src/agent-loop/middlewares/loop-detection.ts.
 *
 * Fires in afterModelCall so it sees this turn's tool calls before dispatch.
 * State is per-op so the lastToolKey / sameToolCount carry across turns.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  checkToolLoops,
  hasSeenSuccessfulCommittingCall,
  noteToolResults,
  createLoopState,
  type LoopState,
} from "../../agent-guards/index.js";
import { autonomousStrategyPivot, restorePersistedPivot } from "./strategy-pivot.js";

function toLoopCalls(toolCalls: { tool: string; args: unknown }[]): { name: string; arguments: string }[] {
  return toolCalls.map(tc => ({
    name: tc.tool,
    arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
  }));
}

function consumePivot(state: LoopState): void {
  state.pendingStrategyPivot = null;
  state.identicalResultRepeats = 0;
  state.iterationsSinceProgress = 0;
  for (const name of state.toolNameCounts.keys()) state.toolNameCounts.set(name, 0);
}

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
    consumePivot(state);
    return autonomousStrategyPivot(ctx, pattern);
  },

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length === 0) return { kind: "continue" };
    const { loopGuardTier } = await import("../../model-tiers.js");
    const modelTier = loopGuardTier(ctx.model);
    const state = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const loopCalls = toLoopCalls(ctx.toolCalls);
    if (ctx.op.lane !== "interactive" && hasSeenSuccessfulCommittingCall(loopCalls, state)) {
      const pivot = autonomousStrategyPivot(ctx, "mutation-repeat");
      ctx.toolCalls.length = 0;
      return pivot.kind === "nudge" ? { ...pivot, skipToolDispatch: true } : pivot;
    }
    // Interactive chat runs nudge-only: a runaway spin (the grok `ls` loop)
    // must be broken, but a legitimate repeated call that the user actually
    // needs must never have its turn hard-killed. Worker/build/ide lanes arm
    // a strategy change instead of terminating the unattended operation.
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
    if (ctx.op.lane !== "interactive" && observation.pendingPivot) {
      const pattern = observation.pendingPivot;
      consumePivot(state);
      return autonomousStrategyPivot(ctx, pattern);
    }
    return { kind: "continue" };
  },
};
