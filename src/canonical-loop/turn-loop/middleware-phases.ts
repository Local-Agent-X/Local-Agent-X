/**
 * The turn's three middleware phases and the sticky directive they produce.
 *
 * Owns: composing each phase's CanonicalLoopContext (one composer per turn,
 * so all three read the same middleware stack and evidence history), running
 * the phase, and turning its verdict into what the conductor acts on —
 *   beforeTurn          ends the turn on the spot (abort, suspend) or appends
 *                       a nudge THIS turn's adapter reads;
 *   afterModelCall      the first sticky directive, falling back to the idle
 *                       watchdog's suspend on a stalled worker lane;
 *   afterToolExecution  a directive only when afterModelCall set none.
 * Also owns whether a directive suppresses tool dispatch.
 *
 * Does not own: the middlewares or the phase runner (middlewares/), what a
 * directive does once the turn is durable (apply-directive.ts), the abort and
 * suspension result shapes (nudges.ts middlewareAbortResult, suspension.ts),
 * or the dispatch itself (dispatch-tools.ts).
 */
import type { Op } from "../../ops/types.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import type { ToolCallSummary } from "../types.js";
import type { FiredMiddlewareResult } from "../middlewares/host.js";
import type { ModelCall } from "./model-call.js";
import type { ResolvedTurnLoopDeps } from "./turn-deps.js";
import type { DriveTurnResult, MiddlewareDirective } from "./types.js";
import { idleSuspension, middlewareSuspension, suspendedTurn } from "./suspension.js";
import { firedResultFire } from "./guard-fire.js";

type MiddlewarePhaseDeps = Pick<ResolvedTurnLoopDeps,
  | "createTurnContextComposer" | "runMiddlewarePhase" | "middlewareAbortResult"
  | "appendNudgeAsUserMessage" | "buildToolResultsView" | "extractToolResultText">;

// Map a per-phase middleware verdict (afterModelCall / afterToolExecution) to
// the sticky MiddlewareDirective. Both phases translate abort/nudge/suspend the
// same way — the first non-continue verdict wins, later phases only refine — so
// the mapping lives here once instead of inline per phase. A `continue` verdict
// falls through middlewareSuspension to null (no directive).
function directiveFromPhaseResult(res: FiredMiddlewareResult): MiddlewareDirective | null {
  if (res.kind === "abort") {
    return {
      kind: "abort",
      reason: res.reason,
      firedBy: res.firedBy ?? "unknown",
      message: res.message,
    };
  }
  if (res.kind === "nudge") {
    return {
      kind: "nudge",
      reason: res.reason,
      firedBy: res.firedBy ?? "unknown",
      message: res.message,
      metadata: res.metadata,
      skipToolDispatch: res.skipToolDispatch,
    };
  }
  return middlewareSuspension(res);
}

/** If a middleware aborted, skip tool dispatch — same effect as agent-loop's
 *  runPhase short-circuit before tool execution. A nudge that asked for it
 *  (loop-detection's mutation-repeat branch) skips it too. */
export function directiveSkipsToolDispatch(directive: MiddlewareDirective | null): boolean {
  return directive?.kind === "abort"
    || (directive?.kind === "nudge" && directive.skipToolDispatch === true);
}

/** Created once per turn, after the inject drain, so the composer snapshots
 *  the op as this turn starts. */
export function createTurnMiddlewarePhases(op: Op, turnIdx: number, deps: MiddlewarePhaseDeps) {
  const contextComposer = deps.createTurnContextComposer(op, turnIdx);
  const { middlewareStack } = contextComposer;
  return {
    /** A result when the phase ended the turn; null when the turn goes on.
     *  Snapshot a fresh CanonicalLoopContext from disk + op state. A `nudge`
     *  here appends a synthetic user message at the CURRENT turnIdx so this
     *  turn's adapter sees it (mirrors agent-loop's beforeIteration→push-then-
     *  restart-iteration). An `abort` short-circuits the whole turn — no
     *  adapter call, no tool dispatch — and the worker exits. */
    async beforeTurn(): Promise<DriveTurnResult | null> {
      const beforeCtx = contextComposer.build();
      const beforeRes = await deps.runMiddlewarePhase(beforeCtx, "beforeTurn", middlewareStack);
      if (beforeRes.kind === "abort") {
        return deps.middlewareAbortResult(op, turnIdx, beforeRes);
      }
      const beforeSuspension = suspendedTurn(op.id, turnIdx, beforeRes);
      if (beforeSuspension) return beforeSuspension;
      if (beforeRes.kind === "nudge") {
        deps.appendNudgeAsUserMessage(op.id, turnIdx, beforeRes.message, firedResultFire(beforeRes), beforeRes.metadata);
        // Fall through — next read of op_messages (buildTurnInput) picks the
        // nudge up and ships it to the adapter on this turn.
      }
      return null;
    },

    /** Build a fresh context view from this turn's emitted assistant text +
     *  tool calls. Middlewares may MUTATE ctx.toolCalls (auto-build-app
     *  appends a synthetic build_app call) — the context holds the same array
     *  reference the turn will dispatch from, so any synthetic call lands in
     *  the toolCalls list before dispatchTools fires. */
    async afterModelCall(call: ModelCall): Promise<MiddlewareDirective | null> {
      const { result, toolCalls } = call;
      const afterModelCtx = contextComposer.build({
        toolCalls,
        assistantContent: call.assistantText,
      });
      // Wire the live toolCalls array so auto-build-app's push mutates the
      // dispatcher's input. buildCanonicalLoopContext already passes it; this
      // is documentation for the next reader.
      afterModelCtx.toolCalls = toolCalls;
      // Thread this turn's REAL reasoning/usage signals so the empty-turn handling
      // can tell a reasoning-burn turn from a genuinely empty one (HE-5).
      const usageOut = (result.providerState?.providerPayload as { usageOutputTokens?: unknown } | undefined)?.usageOutputTokens;
      afterModelCtx.hasReasoning = call.sawReasoning;
      afterModelCtx.modelEnded = result.modelStop === "ended";
      afterModelCtx.completionTokens = typeof usageOut === "number" ? usageOut : undefined;
      const afterModelRes = await deps.runMiddlewarePhase(afterModelCtx, "afterModelCall", middlewareStack);
      return directiveFromPhaseResult(afterModelRes) ?? idleSuspension(op.lane, call.adapterError);
    },

    /** The conductor runs this only when no directive is set yet: the first
     *  non-continue verdict from afterModelCall wins; afterToolExecution only
     *  refines (not overrides) — matches agent-loop's per-phase ordering. */
    async afterToolExecution(
      call: ModelCall,
      toolMessages: CommitTurnMessage[],
      toolSummary: ToolCallSummary[],
    ): Promise<MiddlewareDirective | null> {
      const toolResultsView = deps.buildToolResultsView(toolMessages, toolSummary, deps.extractToolResultText);
      const afterToolCtx = contextComposer.build({
        toolCalls: call.toolCalls,
        toolResults: toolResultsView,
        assistantContent: call.assistantText,
      });
      const afterToolRes = await deps.runMiddlewarePhase(afterToolCtx, "afterToolExecution", middlewareStack);
      return directiveFromPhaseResult(afterToolRes);
    },
  };
}
