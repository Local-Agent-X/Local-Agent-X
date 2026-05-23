// The six detector functions. Each is pure: takes TurnState, returns either
// a RetryInstruction (turn needs a nudge) or null (turn is fine).

import { isCommittingTool } from "../committing-tool-check.js";
import {
  PLANNING_ONLY_INSTRUCTION,
  SINGLE_ACTION_STOP_INSTRUCTION,
  REASONING_ONLY_INSTRUCTION,
  EMPTY_RESPONSE_INSTRUCTION,
  UNCOMMITTED_TURN_INSTRUCTION,
  EVIDENCE_STALE_INSTRUCTION,
} from "./instructions.js";
import {
  PLANNING_FUTURE_PROMISE,
  ACTION_VERB,
  CONTINUATION_CUE,
  COMPLETION_OPENER,
  COMPLETION_PHRASE_AT_SENTENCE_START,
  RETRY_SAFE_EXPLORATORY_TOOLS,
} from "./patterns.js";
import type { RetryInstruction, TurnState } from "./state.js";

/** Model promised future action but made no tool call. */
export function detectPlanningOnly(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (!state.assistantText) return null;
  const text = state.assistantText;
  // Recap-style completion replies (e.g. "Done. Recap: ...", "Patch landed",
  // "All three fixes are in place") often contain incidental "I'll restart
  // the server" notes that trip the planning regexes. Two ways to detect
  // a recap:
  //   1. Reply OPENS with a completion marker (Done/Shipped/Fixed/...)
  //   2. Reply contains a past-tense completion phrase ANYWHERE (Built X,
  //      Wrote X, Created X, Shipped X, ...) — covers the case where the
  //      reply opens with a status line ("Build CLI timed out. I'll write
  //      it directly...") but ends with a real recap.
  // Either way, if a committing tool ran this turn we treat it as a recap,
  // not a plan, and skip the planning-only retry.
  const looksLikeRecap = COMPLETION_OPENER.test(text) || COMPLETION_PHRASE_AT_SENTENCE_START.test(text);
  if (looksLikeRecap) {
    for (const name of state.toolsCalledThisTurn) {
      if (isCommittingTool(name)) return null;
    }
  }
  if (!PLANNING_FUTURE_PROMISE.test(text)) return null;
  if (!ACTION_VERB.test(text)) return null;
  return { kind: "planning-only", instruction: PLANNING_ONLY_INSTRUCTION };
}

/**
 * Model ran ONE exploratory read tool, then emitted a continuation promise
 * but didn't follow through. This is the numberblocks-style bug.
 */
export function detectSingleActionStop(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length !== 1) return null;
  const onlyCall = state.toolCallsThisIteration[0];
  if (!RETRY_SAFE_EXPLORATORY_TOOLS.has(onlyCall.name)) return null;
  if (!state.assistantText) return null;
  // Needs either a future-promise phrase OR a continuation cue right after
  // the exploratory tool's summary.
  if (!PLANNING_FUTURE_PROMISE.test(state.assistantText) && !CONTINUATION_CUE.test(state.assistantText)) {
    return null;
  }
  return { kind: "single-action-stop", instruction: SINGLE_ACTION_STOP_INSTRUCTION };
}

/** Model emitted reasoning tokens but no user-visible text. */
export function detectReasoningOnly(state: TurnState): RetryInstruction | null {
  if (!state.hasReasoning) return null;
  if (state.assistantText && state.assistantText.trim().length > 0) return null;
  if (state.toolCallsThisIteration.length > 0) return null;
  return { kind: "reasoning-only", instruction: REASONING_ONLY_INSTRUCTION };
}

/** Model emitted nothing at all — empty text, no tools, zero tokens. */
export function detectEmptyResponse(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (state.assistantText && state.assistantText.trim().length > 0) return null;
  if (state.hasReasoning) return null; // reasoning-only detector handles this
  if (state.completionTokens > 0) return null; // tokens produced but not visible — different issue
  return { kind: "empty-response", instruction: EMPTY_RESPONSE_INSTRUCTION };
}

/**
 * Turn is ending (no tools this iteration) but no committing tool was
 * called in the whole turn. This catches the "ran exploratory tools,
 * never actually did the work" pattern.
 */
export function detectUncommittedTurn(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (state.iteration === 0) return null; // iter 0 with no tools is handled by planning-only + empty-response
  let hasCommit = false;
  for (const name of state.toolsCalledThisTurn) {
    if (isCommittingTool(name)) { hasCommit = true; break; }
  }
  if (hasCommit) return null;
  // Only nudge once per turn for this class; caller tracks the counter.
  return { kind: "uncommitted-turn", instruction: UNCOMMITTED_TURN_INSTRUCTION };
}

/**
 * Evidence counter flat for 2+ rounds AND no committing tool was called
 * in that window. Prevents endless exploration.
 */
export function detectEvidenceStale(state: TurnState): RetryInstruction | null {
  // Skip if the agent JUST called a tool this iteration — its result hasn't
  // landed in evidence yet, so the flat-history signal is premature. Firing
  // here also creates orphan tool_calls (we'd push assistant.tool_calls to
  // messages and then `continue` past executeToolCalls), which crashes the
  // next API call with 400 "No tool output found". Mirrors the same guard
  // present on planning-only / uncommitted-turn / reasoning-only / empty-
  // response — was missed when this detector was added.
  if (state.toolCallsThisIteration.length > 0) return null;
  const history = state.evidenceHistory;
  if (history.length < 3) return null;
  const last = history[history.length - 1];
  const prior1 = history[history.length - 2];
  const prior2 = history[history.length - 3];
  if (last !== prior1 || prior1 !== prior2) return null;
  let hasCommit = false;
  for (const name of state.toolsCalledThisTurn) {
    if (isCommittingTool(name)) { hasCommit = true; break; }
  }
  if (hasCommit) return null;
  return { kind: "evidence-stale", instruction: EVIDENCE_STALE_INSTRUCTION };
}
