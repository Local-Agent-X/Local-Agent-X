/**
 * Budget ladder — a self-assessment when a long op stops producing anything
 * new, and an honest stop when it stays that way.
 *
 * The gap this fills: the iteration budget was a wall, not a decision point.
 * An op ran to `maxIterations` and only THEN reported a checkpoint — a real
 * 160-turn chat op spent ~110 of those turns re-running one procedure and
 * re-asserting a fact it had already proven, and nothing asked it to step back
 * until the budget was gone. Every loop detector in agent-guards keys on the
 * SHAPE of tool calls; this one keys on the passage of budget with nothing to
 * show for it, so it still fires on a stuck run whose shape is irregular
 * enough to slip past all of them.
 *
 * At each RUNG (25/50/75% of maxIterations) the op's progress count
 * (loop-detection's `progressTotal` — distinct tool results,
 * volatility-normalized by loop-progress.noveltySignature, PLUS distinct
 * mutation targets, so write-only work counts) is compared with the count at
 * the previous rung:
 *
 *   - It moved, or this is the first rung: nothing is said. A run that is
 *     learning or building is not interrupted. Every rung used to announce
 *     "you are N% through this task's iteration budget", and a productive run
 *     read that as a deadline: four of the five recorded code runs that
 *     reached step 120 ended within five steps of the 75% message
 *     (2026-11-12), though no cap was near — the counter resets while a run
 *     progresses (checkpoint-stop.ts).
 *   - It did not move (one flat rung): one self-assessment — the goal, what
 *     changed, the next falsifiable test, whether the user is needed — the
 *     questions a senior engineer asks when a task is running long.
 *   - It did not move for a second rung in a row: the op has spent half its
 *     budget without learning or building one new thing, and is told to stop
 *     and ask rather than spend the rest.
 *
 * The counter is MONOTONIC; the `seenResultSigs` Set beside it is a bounded
 * FIFO whose `.size` saturates at RESULT_SIG_MEMORY, so reading the Set would
 * call every long productive op flat once it passed 256 distinct results.
 *
 * Reads loop-detection's LoopState rather than counting novelty again — one
 * definition of "did we learn something", extended, not forked. When that
 * state is absent (loop-detection skipped, or no tools dispatched yet) it
 * reads as zero, and an op that never dispatches a tool is flat by that
 * count too.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { createLoopState, type LoopState } from "../../agent-guards/index.js";

/** Fractions of the iteration budget at which progress is checked. */
const RUNGS = [0.25, 0.5, 0.75];

/** Below this budget the ladder is noise — a 12-iteration verification op does
 *  not need three self-assessments. */
const MIN_BUDGET_FOR_LADDER = 40;

interface LadderState {
  /** Rung fractions already fired, so a rung never repeats on a retried turn. */
  fired: Set<number>;
  /** progressTotal at the previous rung, or null before the first. */
  lastEvidenceCount: number | null;
  /** Consecutive rungs that saw no new distinct results. */
  dryRungs: number;
}

const LADDER_KEY = "budget-ladder";

function createLadderState(): LadderState {
  return { fired: new Set(), lastEvidenceCount: null, dryRungs: 0 };
}

function assessmentNudge(): string {
  return [
    `SYSTEM: this task has run a long stretch that produced nothing new — no new result and no new file. Before continuing, answer these to yourself in one short paragraph:`,
    `  1. What is the goal, stated as the user would state it?`,
    `  2. What has actually changed over that stretch — evidence, not activity?`,
    `  3. What is the next test that could prove you wrong, rather than another confirmation of what you already believe?`,
    `  4. Is there anything you cannot determine from here that only the user can supply?`,
    `If the honest answer to 2 is "nothing", change approach or tell the user where you are. Do not repeat the last stretch.`,
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
    // The largest rung this turn has reached but not yet checked. Taking the
    // largest (not the first) matters when a budget is small enough that two
    // rungs land on adjacent turns — the op should not be checked twice in a row.
    let rung: number | null = null;
    for (const fraction of RUNGS) {
      if (state.fired.has(fraction)) continue;
      if (ctx.turnIdx >= Math.floor(maxIterations * fraction)) rung = fraction;
    }
    if (rung === null) return { kind: "continue" };
    state.fired.add(rung);

    // Evidence check against loop-detection's own novelty counter.
    // getMiddlewareState returns the SAME object that middleware owns (keyed per
    // op), so this reads live counts rather than a copy; creating it when absent
    // is harmless — a fresh state reads as zero evidence, which cannot count
    // as flat on its own because the first rung has no prior count to compare
    // against. progressTotal, never seenResultSigs.size: the Set is capped
    // and its size goes flat past RESULT_SIG_MEMORY while the op is still learning.
    const loop = getMiddlewareState<LoopState>(ctx.op.id, "loop-detection", createLoopState);
    const evidence = loop.progressTotal;
    const dry = state.lastEvidenceCount !== null && evidence === state.lastEvidenceCount;
    state.dryRungs = dry ? state.dryRungs + 1 : 0;
    state.lastEvidenceCount = evidence;

    // Progress since the last rung: a run that is learning or building is left alone.
    if (state.dryRungs === 0) return { kind: "continue" };
    if (state.dryRungs >= 2) {
      state.dryRungs = 0; // one stop per two dry rungs, not one per turn after
      return { kind: "nudge", message: dryStopNudge(), reason: "budget-ladder-dry" };
    }
    return { kind: "nudge", message: assessmentNudge(), reason: "budget-ladder" };
  },
};
