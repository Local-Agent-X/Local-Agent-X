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

// Ordered. `theory-falsification` is FIRST because every other rung tells the
// agent to ACT differently — synthesize, reroute, re-decompose, refresh — and
// none of them challenges what it BELIEVES. An agent holding a wrong theory
// takes all four and stays wrong: it looks productive the whole time, because
// it is editing files and the results genuinely differ.
//
// Measured: a clone-matching op spent 76 turns patching an override stylesheet
// because the two sites built their mobile page by different mechanisms. No
// rung here would have surfaced that; "which mechanism does the original
// actually use" would have, in one call. So the cheapest rung asks for the
// belief and the observation that kills it, before any more work is done.
//
// This makes the rotation 5, which loosens the worker ceiling by one rung
// (workerStrategyPivot aborts after all STRATEGIES have been offered with no
// novel result). Deliberate: the worst case gets one rung longer, the typical
// case should get much shorter because this rung can END the loop rather than
// redirect it, and the wall clock backstops every lane regardless.
const STRATEGIES = [
  "theory-falsification",
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
// CYCLE-armed pivots only. The guard also arms pivots for exact-repeat and
// no-progress, and those fire on the shape of CORRECT work: a worker polling
// `GET /jobs/123` and reading `{"status":"pending"}` eleven times before the
// job finishes, or retrying through a run of identical 429s, repeats the same
// call and never sees a novel result — the exact-repeat pivot arms every turn
// on medium tiers. Counting those pivots aborted the poll at turn 6 (medium) /
// 11 (strong) where the pre-ceiling guard nudged it and let it finish. Those
// pivots are still offered, but only a pivot the deferred cycle detector armed
// (agent-guards loop-detection.ts, `pendingPivotFromCycle`) advances the
// count: the livelock is a multi-step CIRCLE, and a poll is not. That flag
// lives for exactly one call: checkToolLoops sets it and the middleware's
// afterModelCall consumes it (middlewares/loop-detection.ts consumePivot)
// before returning — no other phase ever reads it true.
//
// One pivot per turn, whichever detector armed it: every offer stamps
// `lastPivotTurn`, and afterToolExecution will not offer a second pivot on a
// turn that already carries one — a non-cycle pivot offered at beforeTurn
// still stops the post-dispatch re-arm from piling on in the same turn.
//
// State lives in the per-op middleware registry (state.ts), cleared on the
// op's terminal hook; a process restart starts the count over, which errs
// toward giving the worker another full cycle rather than aborting early.

export const PIVOT_CEILING_KEY = "strategy-pivot-ceiling";

export interface PivotCeilingState {
  /** CYCLE-armed strategy pivots offered since the last novel tool result. */
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

/** Which detector armed the pivot being offered — see the header. */
export interface PivotOrigin {
  /** Armed by the deferred cycle detector: counts toward (and can trip) the ceiling. */
  fromCycle: boolean;
}

/**
 * Offer the worker its next strategy — or, past the ceiling, end the op the
 * way the interactive nudge ceiling ends a turn: a visible note on the
 * stream and an `abort` verdict the turn loop turns into a terminal error.
 * Only a cycle-armed pivot reads or advances the ceiling; every other pivot
 * is offered exactly as it was before the ceiling existed.
 */
export function workerStrategyPivot(
  ctx: CanonicalLoopContext,
  ceiling: PivotCeilingState,
  pattern: AutonomousPivotPattern,
  origin: PivotOrigin,
): CanonicalMiddlewareResult {
  if (origin.fromCycle) {
    if (ceiling.offered >= STRATEGIES.length) {
      const note = pivotCeilingNote(pattern);
      logRetry({ kind: "loop-abort", tool: "pivot-ceiling", detail: { pattern, offered: ceiling.offered, ceiling: STRATEGIES.length } });
      ctx.onEvent?.({ type: "stream", delta: note });
      return { kind: "abort", reason: "loop-detection", message: note };
    }
    ceiling.offered++;
  }
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
    case "theory-falsification":
      instruction = "State, in one sentence, the theory your last few actions assumed. Name the single cheapest observation that would prove that theory WRONG — not one that would confirm it. Go get that observation before you change anything else. If no observation could disprove it, you are not testing a theory, you are repeating a habit: say so and pick a different explanation for what you are seeing.";
      break;
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
