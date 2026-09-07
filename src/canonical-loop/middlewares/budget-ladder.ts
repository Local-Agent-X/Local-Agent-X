/**
 * Budget ladder — forced self-assessment at fractions of the op's iteration
 * budget, and an honest stop when two consecutive rungs learn nothing.
 *
 * The gap this fills: the iteration budget was a wall, not a decision point.
 * An op ran to `maxIterations` and only THEN reported a checkpoint — a real
 * 160-turn chat op spent ~110 of those turns re-running one procedure and
 * re-asserting a fact it had already proven, and nothing asked it to step back
 * until the budget was gone. Every loop detector in agent-guards keys on the
 * SHAPE of tool calls; this one keys on nothing but the passage of budget, so
 * it still fires on a stuck run whose shape is irregular enough to slip past
 * all of them.
 *
 * Two mechanisms, deliberately cheap:
 *
 *   1. RUNGS at 25/50/75% of maxIterations inject one self-assessment nudge
 *      (~4 turns out of 160). The nudge asks for the goal, what changed since
 *      the last rung, the next falsifiable test, and whether the user is
 *      needed — the questions a senior engineer asks when a task is running
 *      long.
 *
 *   2. A DRY-RUNG check: the number of distinct tool results the op has ever
 *      seen (loop-detection's seenResultSigs, already volatility-normalized by
 *      loop-progress.noveltySignature) is snapshotted at each rung. If two
 *      consecutive rungs show the same count, the op has burned a quarter of
 *      its budget without learning one new thing, and it is told to stop and
 *      ask rather than spend the rest.
 *
 * Reads loop-detection's LoopState rather than counting novelty again — one
 * definition of "did we learn something", extended, not forked. When that
 * state is absent (loop-detection skipped, or no tools dispatched yet) the
 * dry check is simply not applied; the rung nudge still fires.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { createLoopState, type LoopState } from "../../agent-guards/index.js";

/** Fractions of the iteration budget at which to force a self-assessment. */
const RUNGS = [0.25, 0.5, 0.75];

/** Below this budget the ladder is noise — a 12-iteration verification op does
 *  not need three self-assessments. */
const MIN_BUDGET_FOR_LADDER = 40;

interface LadderState {
  /** Rung fractions already fired, so a rung never repeats on a retried turn. */
  fired: Set<number>;
  /** Distinct-result count at the previous rung, or null before the first. */
  lastEvidenceCount: number | null;
  /** Consecutive rungs that saw no new distinct results. */
  dryRungs: number;
}

const LADDER_KEY = "budget-ladder";

function createLadderState(): LadderState {
  return { fired: new Set(), lastEvidenceCount: null, dryRungs: 0 };
}

function assessmentNudge(pct: number): string {
  return [
    `SYSTEM: you are ${pct}% through this task's iteration budget. Before continuing, answer these to yourself in one short paragraph:`,
    `  1. What is the goal, stated as the user would state it?`,
    `  2. What has actually changed since the last checkpoint — evidence, not activity?`,
    `  3. What is the next test that could prove you wrong, rather than another confirmation of what you already believe?`,
    `  4. Is there anything you cannot determine from here that only the user can supply?`,
    `If the honest answer to 2 is "nothing", change approach or tell the user where you are. Do not spend the remaining budget repeating the last stretch.`,
  ].join("\n");
}

function dryStopNudge(): string {
  return [
    `SYSTEM: two checkpoints in a row have passed with no new information — you have spent a large share of this task's budget without learning anything you did not already know.`,
    `Stop here and report honestly: what you established, what you could not determine and why, and what you would need from the user to get further.`,
    `Asking a question you cannot answer yourself is a complete outcome. Continuing to re-verify what you have already proven is not.`,
  ].join("\n");
}

export const budgetLadderMiddleware: CanonicalMiddleware = {
  name: "budget-ladder",

  beforeTurn(ctx) {
    const maxIterations = ctx.op.contextPack?.budget?.maxIterations;
    if (typeof maxIterations !== "number" || maxIterations < MIN_BUDGET_FOR_LADDER) {
      return { kind: "continue" };
    }

    const state = getMiddlewareState<LadderState>(ctx.op.id, LADDER_KEY, createLadderState);
    // The largest rung this turn has reached but not yet fired. Taking the
    // largest (not the first) matters when a budget is small enough that two
    // rungs land on adjacent turns — the op should not be nudged twice in a row.
    let rung: number | null = null;
    for (const fraction of RUNGS) {
      if (state.fired.has(fraction)) continue;
      if (ctx.turnIdx >= Math.floor(maxIterations * fraction)) rung = fraction;
    }
    if (rung === null) return { kind: "continue" };
    state.fired.add(rung);

    // Evidence check against loop-detection's own novelty set. getMiddlewareState
    // returns the SAME object that middleware owns (keyed per op), so this reads
    // live counts rather than a copy; creating it when absent is harmless — an
    // empty set reads as zero evidence, which cannot fire the dry stop on its
    // own because the first rung has no prior count to compare against.
    const loop = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const evidence = loop.seenResultSigs.size;
    const dry = state.lastEvidenceCount !== null && evidence === state.lastEvidenceCount;
    state.dryRungs = dry ? state.dryRungs + 1 : 0;
    state.lastEvidenceCount = evidence;

    if (state.dryRungs >= 2) {
      state.dryRungs = 0; // one stop per two dry rungs, not one per turn after
      return { kind: "nudge", message: dryStopNudge(), reason: "budget-ladder-dry" };
    }
    return {
      kind: "nudge",
      message: assessmentNudge(Math.round(rung * 100)),
      reason: "budget-ladder",
    };
  },
};
