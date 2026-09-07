// Tool-call loop detection — the one entry point, sequencing five signals
// against the one per-op LoopState:
//   1. Exact-repeat  — same {tool, args} N turns running, UNCHANGED results.
//   2. Cycle         — the same PROCEDURE repeating over a novelty-free span
//                      (loop-progress.ts); catches circles exact-repeat can't.
//   3. No-progress   — N iterations with no progress.
//   4. Redundant search / 5. Discovery loop — loop-discovery.ts.
//
// Progress is result-delta, not tool-identity: a turn progressed if it
// surfaced a result not seen before, or wrote a target not written before.
// Both signals are computed in loop-progress.ts — see that file for why a raw
// content hash and an args-keyed mutation key were each wrong.
//
// Weak/medium models loop harder and faster, so thresholds halve when the
// caller passes modelTier="weak"|"medium".
//
// LoopState is exported because post-commit.ts reuses it — they share the
// per-op flag postCommitNudgePending so a commit detected by post-commit
// surfaces a nudge on the iteration after.

import { createHash } from "node:crypto";
import { logRetry } from "../retry-telemetry.js";
import { isMutationTool, isProgressTool } from "../tool-mutation-check.js";
import { isCommittingTool } from "../committing-tool-check.js";
import {
  cycleAbortNote, cycleNudge, detectCycle, mutationTargetKey, noteTurnShape,
  noveltySignature, rememberNovelResult, RESULT_SIG_MEMORY, turnShapeKey,
  type CycleTurn,
} from "./loop-progress.js";
import {
  checkRedundantSearch, discoveryLimitFor, discoveryNudge, findDiscoveryLoop,
  redundantSearchNudge, searchKeyOf, searchLimitFor, SPIRALABLE_TOOLS,
} from "./loop-discovery.js";
import { chooseStrategyPivot, successfulCommittingCallKey, type StrategyPivotPattern, type ToolResultObservation } from "./strategy-pivot-pattern.js";

function isProtectedCommittingCall(name: string): boolean {
  return isCommittingTool(name) && isMutationTool(name);
}

export interface LoopState {
  lastToolKey: string;
  sameToolCount: number;
  // Result-awareness for exact-repeat: a stuck model repeats the same call AND
  // gets the same result; a legitimate repeat (user asked for N identical runs,
  // polling a changing status, a retry that progresses) gets a DIFFERENT result
  // each time. lastResultSig is the signature of the last result for the
  // current repeated key; identicalResultRepeats counts consecutive repeats
  // that produced an unchanged result. Updated by noteToolResults() after
  // dispatch. Exact-repeat aborts only when these confirm non-progress.
  lastResultSig: string | null;
  identicalResultRepeats: number;
  toolNameCounts: Map<string, number>;
  seenResultSigs: Set<string>;
  // Monotonic lifetime count of novel results (loop-progress.rememberNovelResult).
  // seenResultSigs is capped and its .size saturates; THIS is the progress signal.
  novelResultsTotal: number;
  seenSuccessfulMutationKeys: Set<string>;
  lastTurnHadNovelResult: boolean;
  lastTurnHadNovelMutation: boolean;
  iterationsSinceProgress: number;
  postCommitNudgePending: boolean;
  // Per normalized SEARCH PATTERN, how many times it's been searched this op.
  // The discovery counter resets on any edit/novel-result, so a model that
  // re-runs ONE broad search between edits (with varied globs making each result
  // look novel) sails past it — one cleanup re-grepped a single pattern 26×,
  // burning ~40% of its turn budget before truncation. This counter keys on the
  // PATTERN and never resets on progress, so that diffuse waste is visible.
  searchKeyCounts: Map<string, number>;
  // Lifetime count of loop-break nudges emitted for this op. In the interactive
  // lane the abort paths downgrade to nudges (never kill a turn the user wants),
  // and each path resets its own window so it can't spam per-turn — but nothing
  // bounded the TOTAL: a model that ignored every nudge got re-nudged forever,
  // backstopped only by the wall-clock (up to 2h). Once this exceeds
  // NUDGE_CEILING we escalate to a hard abort even in the interactive lane —
  // six "you're looping, pivot" warnings is enough rope; past that it's a
  // runaway and ending the turn beats spinning. (The user keeps the chat and
  // can just send another message.)
  nudgeCount: number;
  pendingStrategyPivot: StrategyPivotPattern | null;
  // Rolling per-turn SHAPE history for cycle detection (loop-progress.ts) —
  // the multi-turn CIRCLE that burned 110 turns of a real op unseen.
  cycleWindow: CycleTurn[];
  // Mutation TARGETS (tool + path/url) already written this op. Kept separate
  // from seenSuccessfulMutationKeys, which stays args-keyed for the
  // mutation-repeat pivot; progress resets read THIS set, so twelve rewrites
  // of one scratch file count as one advance.
  seenMutationTargets: Set<string>;
}

export function createLoopState(): LoopState {
  return {
    lastToolKey: "",
    sameToolCount: 0,
    lastResultSig: null,
    identicalResultRepeats: 0,
    toolNameCounts: new Map(),
    seenResultSigs: new Set(),
    novelResultsTotal: 0,
    seenSuccessfulMutationKeys: new Set(),
    lastTurnHadNovelResult: false,
    lastTurnHadNovelMutation: false,
    iterationsSinceProgress: 0,
    postCommitNudgePending: false,
    searchKeyCounts: new Map(),
    nudgeCount: 0,
    pendingStrategyPivot: null,
    cycleWindow: [],
    seenMutationTargets: new Set(),
  };
}

// No-progress abort: iterations of consecutive non-mutating tool calls allowed
// before the agent is forced to end its turn. Raised from 12/6 → 25/15 after
// "research the latest tech in X and make a powerpoint" aborted at 6 web_search
// calls — research-then-build workflows legitimately need many read-only steps
// (web_search, web_fetch, snapshot, page extract, image search) before the
// first file write. The discovery-loop detector at DISCOVERY_LOOP_THRESHOLD
// still catches true spirals (8x identical tool); this guard is the backup
// for an agent that's genuinely stuck across many different tools.
export const NO_PROGRESS_LIMIT = 25;
export const NO_PROGRESS_LIMIT_WEAK = 15;
// Lifetime loop-break nudges allowed in the interactive lane before the detector
// stops nudging and hard-aborts the turn. Mirrors the repeat-failure middleware's
// NUDGE_AT/ABORT_AT escalation shape. Generous on purpose — each nudge already
// costs several turns to re-accumulate, so six of them spans many turns of the
// model being told to pivot and ignoring it. The wall-clock ceiling (up to 2h)
// is the only other backstop, so without this a stubborn loop ran far too long.
export const NUDGE_CEILING = 6;
// SPIRALABLE_TOOLS and the exploration-waste detectors moved to
// loop-discovery.ts under the LOC ceiling. Re-exported so existing importers
// (agent-guards/index.ts, the read-only fence test) keep their path.
export { SPIRALABLE_TOOLS } from "./loop-discovery.js";

/**
 * Check for exact-repeat loops and discovery loops. Weak/medium models
 * loop harder and faster than strong ones, so we halve the thresholds:
 * exact-repeat fires at 2x instead of 3x, discovery at 4 instead of 8.
 * Returns a nudge message if a loop is detected, or null.
 *
 * nudgeOnly downgrades the two abort paths (exact-repeat, no-progress) to a
 * nudge — for the interactive lane, where killing a turn out from under the
 * user is worse than letting a spin run one more cycle. The discovery path is
 * already nudge-only regardless.
 */
export function checkToolLoops(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  opts?: { modelTier?: "weak" | "medium" | "strong"; nudgeOnly?: boolean; deferWorkerPivot?: boolean },
): { abort: boolean; nudge: string | null } {
  const isWeakOrMedium = opts?.modelTier === "weak" || opts?.modelTier === "medium";
  const repeatLimit = isWeakOrMedium ? 2 : 3;

  // Every nudge below routes through here so the per-op lifetime ceiling can
  // bound a runaway. In the interactive lane (nudgeOnly), once the model has
  // been nudged past NUDGE_CEILING times and is STILL looping, stop nudging and
  // hard-abort the turn — the only other backstop is the 2h wall-clock. In the
  // worker lane the count still increments but never escalates here (workers
  // already hard-abort via the exact-repeat / no-progress paths).
  const emitNudge = (nudge: string): { abort: boolean; nudge: string | null } => {
    state.nudgeCount++;
    if (opts?.nudgeOnly && state.nudgeCount > NUDGE_CEILING) {
      logRetry({ kind: "loop-abort", tool: "nudge-ceiling", detail: { nudgeCount: state.nudgeCount, ceiling: NUDGE_CEILING, modelTier: opts?.modelTier } });
      return { abort: true, nudge: `SYSTEM: ending the turn — you've been told you're looping ${state.nudgeCount} times and kept going. Stopping now. Report what you established and what you could not determine, and ask the user for what only they can supply (a screenshot, a device you can't reach, a decision). Ending on a question is a complete outcome, not a failure.` };
    }
    return { abort: false, nudge };
  };

  // Exact-repeat detection. Aborts only when the repeated call ALSO keeps
  // producing the same result (confirmed via noteToolResults after each
  // dispatch) — so a user-requested batch of identical commands or a poll
  // whose result changes each turn isn't mistaken for a stuck spin. Detecting
  // non-progress needs ≥2 observed results, so the abort lands one turn later
  // than a result-blind check would; the no-progress + discovery guards below
  // remain the backstop for everything this misses.
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key === state.lastToolKey) {
    state.sameToolCount++;
    if (state.identicalResultRepeats >= repeatLimit - 1) {
      if (opts?.deferWorkerPivot) return { abort: false, nudge: null };
      logRetry({ kind: "loop-abort", tool: toolCalls[0]?.name, detail: { repeatLimit, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
      if (opts?.nudgeOnly) {
        // Interactive chat: never kill the turn out from under the user. Break
        // the spin with a pivot nudge, then reset so it must re-accumulate
        // before nudging again (no per-turn spam if the model keeps spinning).
        // emitNudge escalates to a hard abort once the lifetime ceiling is hit.
        state.identicalResultRepeats = 0;
        return emitNudge(`SYSTEM: ${toolCalls[0]?.name} called with identical arguments and unchanged results ${state.sameToolCount}× — you're looping. Stop repeating it: take a different action, call a different tool, or answer with what you already have.`);
      }
      return { abort: true, nudge: "\n\n(Detected repeated tool calls with unchanging results — stopping loop)" };
    }
  } else {
    state.sameToolCount = 1;
    state.lastToolKey = key;
    state.identicalResultRepeats = 0;
    state.lastResultSig = null;
  }

  // Cycle detection — the multi-turn analogue of exact-repeat, which only ever
  // compares this turn to the one before it and so cannot see a CIRCLE. See
  // loop-progress.ts for why it is gated on a novelty-free span.
  const cycle = detectCycle(state.cycleWindow, { modelTier: opts?.modelTier });
  if (cycle && !opts?.deferWorkerPivot) {
    state.cycleWindow.length = 0; // must re-accumulate before firing again
    logRetry({ kind: "loop-abort", tool: "cycle", detail: { ...cycle, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
    if (opts?.nudgeOnly) return emitNudge(cycleNudge(cycle));
    return { abort: true, nudge: cycleAbortNote(cycle) };
  }

  // Discovery-style loop detection: same READ-ONLY discovery tool (SPIRALABLE_
  // TOOLS, module scope) called 8+ times suggests the agent is spinning trying
  // to find something. Action tools (browser, http_request) are intentionally
  // NOT spiralable — they do progressive work and 8+ sequential calls is normal
  // multi-step automation, not a spiral. Exact-repeat detection above catches
  // true action loops.
  // Two progress signals reset the spiralable counts: isProgressTool (local
  // work incl. bash — the audit-then-edit-then-verify pattern would otherwise
  // accumulate reads across phases and falsely trip the gate) and a novel
  // result from the PRIOR turn (the agent learned something new, so the prior
  // reads were exploration, not a spiral). A discovery tool spun on the SAME
  // result keeps neither signal, so its count climbs to the nudge. isProgressTool
  // derives from the risk taxonomy (tool-mutation-check.ts); the novelty signal
  // is the completed-result delta below.
  let madeProgress = false, newTarget = false;
  for (const tc of toolCalls) {
    if (isProgressTool(tc.name)) madeProgress = true;
    // A mutation counts as immediate progress only when it touches a target
    // this op has not already written. Re-writing one scratch file every lap
    // was what kept iterationsSinceProgress pinned at zero through a
    // 110-turn livelock.
    if (isMutationTool(tc.name)) {
      // Null target (no path/url in args) falls back to the full-args key —
      // the pre-existing behavior. Only path/url calls get the tighter rule.
      const target = mutationTargetKey(tc) ?? successfulCommittingCallKey(tc);
      if (!state.seenMutationTargets.has(target)) newTarget = true;
    }
    state.toolNameCounts.set(tc.name, (state.toolNameCounts.get(tc.name) || 0) + 1);
  }
  if (madeProgress || state.lastTurnHadNovelResult) {
    // Reset only the spiralable counters — progress was made, the prior
    // reads were useful scaffolding, not a spiral. Keep non-spiralable
    // counts intact (they don't gate anything anyway).
    for (const name of SPIRALABLE_TOOLS) state.toolNameCounts.delete(name);
  }
  // Current mutations count immediately; result novelty arrives after dispatch.
  if (newTarget || state.lastTurnHadNovelResult || state.lastTurnHadNovelMutation) {
    state.iterationsSinceProgress = 0;
  } else {
    state.iterationsSinceProgress++;
    const noProgLimit = isWeakOrMedium ? NO_PROGRESS_LIMIT_WEAK : NO_PROGRESS_LIMIT;
    if (state.iterationsSinceProgress >= noProgLimit) {
      if (opts?.deferWorkerPivot) return { abort: false, nudge: null };
      logRetry({ kind: "loop-abort", tool: "no-progress", detail: { iterations: state.iterationsSinceProgress, limit: noProgLimit, modelTier: opts?.modelTier, nudgeOnly: opts?.nudgeOnly ?? false } });
      // Reset so the next turn starts clean whether we abort or just nudge.
      state.iterationsSinceProgress = 0;
      if (opts?.nudgeOnly) {
        return emitNudge(`SYSTEM: ${noProgLimit}+ tool calls with no progress (no file/page/API changes). Step back — take a concrete next action or respond to the user now.`);
      }
      return {
        abort: true,
        nudge: `\n\n(No-progress abort: ${noProgLimit}+ iterations of tool calls with zero file mutations. Your work is either done or stuck. End the turn now.)`,
      };
    }
  }
  // Read-only exploration waste (loop-discovery.ts): re-running one search,
  // and spinning on one discovery tool. checkRedundantSearch mutates the op's
  // searchKeyCounts, so it must run on every pass, not only when it can nudge.
  const redundant = checkRedundantSearch(toolCalls, state.searchKeyCounts, isWeakOrMedium);
  if (redundant && !opts?.deferWorkerPivot) {
    logRetry({ kind: "loop-abort", tool: "redundant-search", detail: { term: redundant.term, count: redundant.count, modelTier: opts?.modelTier } });
    return emitNudge(redundantSearchNudge(redundant.term, redundant.count));
  }

  const stuck = findDiscoveryLoop(state.toolNameCounts, isWeakOrMedium);
  if (stuck && !opts?.deferWorkerPivot) {
    state.toolNameCounts.set(stuck.tool, 0);
    return emitNudge(discoveryNudge(stuck.tool, stuck.count));
  }

  return { abort: false, nudge: null };
}

export function noteToolResults(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
  results: Array<{ content: string; status?: string }>,
  opts?: { modelTier?: "weak" | "medium" | "strong"; armWorkerPivot?: boolean },
): ToolResultObservation {
  let successfulMutation = false;
  let repeatedMutation = false;
  let novelTarget = false;
  const committingResultIndexes = new Set<number>();
  for (const [index, tc] of toolCalls.entries()) {
    const result = results[index];
    if (!result || !isProtectedCommittingCall(tc.name)) continue;
    if (result.status !== undefined && result.status !== "ok") continue;
    committingResultIndexes.add(index);
    const targetKey = mutationTargetKey(tc) ?? successfulCommittingCallKey(tc);
    if (!state.seenMutationTargets.has(targetKey)) {
      novelTarget = true;
      state.seenMutationTargets.add(targetKey);
      if (state.seenMutationTargets.size > RESULT_SIG_MEMORY) {
        state.seenMutationTargets.delete(state.seenMutationTargets.values().next().value!);
      }
    }
    const key = successfulCommittingCallKey(tc);
    if (state.seenSuccessfulMutationKeys.has(key)) {
      repeatedMutation = true;
      continue;
    }
    successfulMutation = true;
    state.seenSuccessfulMutationKeys.add(key);
    if (state.seenSuccessfulMutationKeys.size > RESULT_SIG_MEMORY) {
      state.seenSuccessfulMutationKeys.delete(state.seenSuccessfulMutationKeys.values().next().value!);
    }
  }

  let novel = false;
  for (const [index, result] of results.entries()) {
    if (result.status !== undefined && result.status !== "ok") continue;
    if (committingResultIndexes.has(index)) continue;
    // Volatility-normalized (loop-progress.ts): a raw sha1 made every
    // screenshot and every re-navigated DOM snapshot look like new
    // information, which latched novelty true for the life of any
    // browser-driving op and disarmed every counter downstream.
    const signature = noveltySignature(result.content);
    if (state.seenResultSigs.has(signature)) continue;
    novel = true;
    rememberNovelResult(state, signature);
  }
  state.lastTurnHadNovelResult = novel;
  // Target-keyed, not args-keyed: rewriting one file with new bytes is
  // iteration on a single artifact, not a fresh advance.
  state.lastTurnHadNovelMutation = novelTarget;
  if (novel || successfulMutation) state.pendingStrategyPivot = null;
  // Record this turn's procedure shape for cycle detection, flagged by RESULT
  // novelty only — deliberately not novelTarget.
  //
  // The cycle detector asks "is this procedure teaching us anything?", and
  // creating a file is an action, not information. Counting a new target as
  // novelty here would let an agent defeat the detector by renaming its
  // scratch harness every lap, which is exactly what the recorded livelock
  // did (_mt.html -> _prod.html -> _h.html). Real scaffolding work is not
  // caught by this, because a write's own result names the file it wrote and
  // is therefore novel on its own. The no-progress counter keeps its mutation
  // reset; only this signal is information-gated.
  noteTurnShape(state.cycleWindow, turnShapeKey(toolCalls), novel);

  // Exact-repeat signal — only while the repeated {tool,args} key holds.
  const key = toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join("|");
  if (key !== state.lastToolKey) {
    return { novel, successfulMutation, pendingPivot: state.pendingStrategyPivot };
  }
  const sig = createHash("sha1")
    .update(results.map(r => r.content).join("\x00"))
    .digest("hex");
  if (state.lastResultSig !== null) {
    state.identicalResultRepeats = sig === state.lastResultSig ? state.identicalResultRepeats + 1 : 0;
  }
  state.lastResultSig = sig;

  if (opts?.armWorkerPivot && !novel && !successfulMutation) {
    const weak = opts.modelTier === "weak" || opts.modelTier === "medium";
    const repeatLimit = weak ? 2 : 3;
    const noProgressLimit = weak ? NO_PROGRESS_LIMIT_WEAK : NO_PROGRESS_LIMIT;
    const searchLimit = searchLimitFor(weak);
    const discoveryLimit = discoveryLimitFor(weak);
    state.pendingStrategyPivot = chooseStrategyPivot({
      exactRepeat: state.identicalResultRepeats >= repeatLimit - 1,
      mutationRepeat: repeatedMutation,
      // A detected cycle IS non-progress; the worker lane arms the same
      // strategy pivot rather than a pattern of its own.
      noProgress: state.iterationsSinceProgress >= noProgressLimit
        || detectCycle(state.cycleWindow, { modelTier: opts?.modelTier }) !== null,
      redundantSearch: toolCalls.some(tc => {
        const key = searchKeyOf(tc.name, tc.arguments);
        return key !== null && (state.searchKeyCounts.get(key) ?? 0) >= searchLimit;
      }),
      discoveryLoop: toolCalls.some(tc =>
        SPIRALABLE_TOOLS.has(tc.name) && (state.toolNameCounts.get(tc.name) ?? 0) >= discoveryLimit
      ),
    });
  }

  return { novel, successfulMutation, pendingPivot: state.pendingStrategyPivot };
}

export type { StrategyPivotPattern, ToolResultObservation } from "./strategy-pivot-pattern.js";

export function hasSeenSuccessfulCommittingCall(
  toolCalls: Array<{ name: string; arguments: string }>,
  state: LoopState,
): boolean {
  return toolCalls.some(call =>
    isProtectedCommittingCall(call.name) && state.seenSuccessfulMutationKeys.has(successfulCommittingCallKey(call))
  );
}
