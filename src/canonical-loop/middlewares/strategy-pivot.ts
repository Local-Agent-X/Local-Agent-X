import { readOpMessages } from "../store.js";
import { forceCompactNext } from "../turn-loop/compact-history.js";
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
