import { readOpMessages } from "../store.js";
import { forceCompactNext } from "../turn-loop/compact-history.js";
import { logRetry } from "../../retry-telemetry.js";
import type { CanonicalLoopContext, CanonicalMiddlewareResult } from "./types.js";
import type { StrategyPivotPattern } from "../../agent-guards/index.js";

export type AutonomousPivotPattern =
  | StrategyPivotPattern
  | "flat-evidence"
  | "monotonous-action";

interface PersistedPivot {
  turnIdx: number;
  strategyPivot: {
    pattern: string;
    strategyId: string;
    epoch: number;
  };
}

const STRATEGIES = [
  "evidence-synthesis",
  "alternate-route",
  "step-redecomposition",
  "context-refresh",
] as const;

const refreshedTurnByOp = new Map<string, number>();

export function _resetPersistedPivotRestores(): void {
  refreshedTurnByOp.clear();
}

// ── Worker-lane ceiling ────────────────────────────────────────────────────
//
// On build/background/ide the guard's abort paths are all deferred
// (middlewares/loop-detection.ts passes deferWorkerPivot), and the worker is
// offered one of the four strategies below instead of being killed. That
// rotation had no end: the recorded livelock — the same six-step procedure
// with a renamed scratch file every lap and the same result every time — was
// pivoted through evidence-synthesis, alternate-route, step-redecomposition,
// context-refresh and back again until the 15-minute wall clock. The
// interactive lane has a nudge ceiling (agent-guards NUDGE_CEILING); this is
// its worker-lane analogue: once every strategy has been offered and no tool
// RESULT has been novel since the first of them, the op is aborted with a
// note naming the cycle.
//
// RESULT, not target, on purpose: a renamed scratch file is a new mutation
// target and must keep counting as progress for the checkpoint (write-only
// work is not dry — checkpoint-stop.ts), but it is exactly what a stuck agent
// varies while learning nothing. Only information resets this counter.
//
// State lives in the per-op middleware registry (state.ts), cleared on the
// op's terminal hook; a process restart starts the count over, which errs
// toward giving the worker another full cycle rather than aborting early.

export const PIVOT_CEILING_KEY = "strategy-pivot-ceiling";

export interface PivotCeilingState {
  /** Strategy pivots offered since the last novel tool result. */
  offered: number;
  /** Turn of the most recent pivot — one pivot per turn, whichever phase arms it. */
  lastPivotTurn: number;
}

export function createPivotCeilingState(): PivotCeilingState {
  return { offered: 0, lastPivotTurn: -1 };
}

/** A tool result carried new information: the worker is not stuck in the
 *  cycle the pivots were addressing. Every strategy is available again. */
export function notePivotEvidence(ceiling: PivotCeilingState, novelResult: boolean): void {
  if (novelResult) ceiling.offered = 0;
}

function pivotCeilingNote(pattern: AutonomousPivotPattern): string {
  return `\n\n(Strategy-pivot ceiling: ${pattern} persisted through all ${STRATEGIES.length} strategies (${STRATEGIES.join(", ")}) with no new information since the first pivot — the same cycle keeps repeating. Ending the operation; its work so far is saved.)`;
}

/**
 * Offer the worker its next strategy — or, past the ceiling, end the op the
 * way the interactive nudge ceiling ends a turn: a visible note on the
 * stream and an `abort` verdict the turn loop turns into a terminal error.
 */
export function workerStrategyPivot(
  ctx: CanonicalLoopContext,
  ceiling: PivotCeilingState,
  pattern: AutonomousPivotPattern,
): CanonicalMiddlewareResult {
  if (ceiling.offered >= STRATEGIES.length) {
    const note = pivotCeilingNote(pattern);
    logRetry({ kind: "loop-abort", tool: "pivot-ceiling", detail: { pattern, offered: ceiling.offered, ceiling: STRATEGIES.length } });
    ctx.onEvent?.({ type: "stream", delta: note });
    return { kind: "abort", reason: "loop-detection", message: note };
  }
  ceiling.offered++;
  ceiling.lastPivotTurn = ctx.turnIdx;
  return autonomousStrategyPivot(ctx, pattern);
}

function persistedPivots(opId: string): PersistedPivot[] {
  const out: PersistedPivot[] = [];
  for (const row of readOpMessages(opId)) {
    if (!row.content || typeof row.content !== "object") continue;
    const content = row.content as { kind?: unknown; strategyPivot?: unknown };
    if (content.kind !== "nudge" || !content.strategyPivot || typeof content.strategyPivot !== "object") continue;
    const pivot = content.strategyPivot as Record<string, unknown>;
    if (typeof pivot.pattern !== "string" || typeof pivot.strategyId !== "string" || typeof pivot.epoch !== "number") continue;
    out.push({
      turnIdx: row.turnIdx,
      strategyPivot: {
        pattern: pivot.pattern,
        strategyId: pivot.strategyId,
        epoch: pivot.epoch,
      },
    });
  }
  return out;
}

/** Reapply an ephemeral context refresh after process restart without writing a
 * second synthetic nudge for the same turn. */
export function restorePersistedPivot(ctx: CanonicalLoopContext): boolean {
  const current = persistedPivots(ctx.op.id).find(p => p.turnIdx === ctx.turnIdx);
  if (!current) return false;
  if (
    current.strategyPivot.strategyId === "context-refresh"
    && refreshedTurnByOp.get(ctx.op.id) !== current.turnIdx
  ) {
    refreshedTurnByOp.set(ctx.op.id, current.turnIdx);
    forceCompactNext(ctx.op.id);
  }
  return true;
}

export function autonomousStrategyPivot(
  ctx: CanonicalLoopContext,
  pattern: AutonomousPivotPattern,
): CanonicalMiddlewareResult {
  const prior = persistedPivots(ctx.op.id);
  const sequence = prior.length;
  const strategyId = STRATEGIES[sequence % STRATEGIES.length];
  const epoch = Math.floor(sequence / STRATEGIES.length) + 1;
  const delegation = ctx.toolNames?.has("agent_spawn")
    ? " If a genuinely independent subproblem remains, agent_spawn is available through the normal tool path."
    : "";

  let instruction: string;
  switch (strategyId) {
    case "evidence-synthesis":
      instruction = "Stop repeating the stalled operation. Synthesize the evidence already collected, choose the smallest unfinished action that changes the task state, execute it, and verify the result.";
      break;
    case "alternate-route":
      instruction = "Use a different authorized route: change the tool family, source, path, or argument structure. Do not retry the stalled operation until another action produces new evidence.";
      break;
    case "step-redecomposition":
      instruction = `Re-decompose the current goal into the smallest independently verifiable unfinished step, execute that step, then verify it before continuing.${delegation}`;
      break;
    case "context-refresh":
      instruction = "Start a fresh replan epoch from the durable task, open steps, and transcript evidence. Pick a materially different tactic and continue the same operation; do not repeat the stalled call.";
      break;
  }

  return {
    kind: "nudge",
    reason: "strategy-pivot",
    message: `AUTONOMOUS STRATEGY PIVOT (${pattern}; epoch ${epoch}; ${strategyId}): ${instruction}`,
    metadata: { strategyPivot: { pattern, strategyId, epoch } },
  };
}
