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
  INCOMPLETE_MULTISTEP_INSTRUCTION,
} from "./instructions.js";
import {
  PLANNING_FUTURE_PROMISE,
  ACTION_VERB,
  CONTINUATION_CUE,
  COMPLETION_OPENER,
  COMPLETION_PHRASE_AT_SENTENCE_START,
  RETRY_SAFE_EXPLORATORY_TOOLS,
  highestClaimedStep,
  isWaitingOnUser,
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

// CONTINUATION_CUE alone matches "then/next/after" ANYWHERE — including
// descriptive prose ("the event happens next Tuesday"), which is normal
// narration, not a stalled promise. Only a cue that LEADS a sentence
// ("Next, edit the file", "Then: run the tests") reads as forward intent,
// so anchor the canonical cue list the same way
// COMPLETION_PHRASE_AT_SENTENCE_START anchors its phrases.
const CONTINUATION_CUE_AT_SENTENCE_START = new RegExp(
  "(?:^|[.!?]\\s+|\\n)\\s*(?:[*_`#>-]\\s*)?" + CONTINUATION_CUE.source,
  "i",
);

// A first-person self-action commitment following a continuation cue — the
// signal that separates a genuine self-deferral stall ("Next, I'll edit it")
// from an advisory tail addressed to the user ("Next steps: compare quarterly",
// which has no first-person subject). Scanned in the short window right after
// the cue so a later, unrelated "I" in the reply can't re-trigger it.
const FIRST_PERSON_INTENT_AFTER_CUE =
  /\b(?:i(?:'ll|'m| will| am| plan| need| want| plan\s+to| intend| plan\s+on)|let\s+me|we(?:'ll| will))\b/i;

/**
 * The turn ENDED after exactly one exploratory read tool, with text that
 * promised continuation but never followed through. This is the
 * numberblocks-style bug.
 *
 * Evaluated ONLY on the ending iteration (no tool calls pending): a pending
 * exploratory call means the loop is still running and the model gets to
 * follow through on its own. Firing mid-flight injected "Do not re-explore.
 * Act." into healthy turns — e.g. a research worker doing one web_search
 * per iteration with normal narration.
 */
export function detectSingleActionStop(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null; // turn still going
  if (state.toolsCalledThisTurn.size !== 1) return null;
  const [onlyTool] = state.toolsCalledThisTurn;
  if (!RETRY_SAFE_EXPLORATORY_TOOLS.has(onlyTool)) return null;
  // bash is also a committing tool, and on the ending iteration the command
  // text is no longer in state to prove it was read-only exploration —
  // default to non-exploratory (the documented safe direction: err toward
  // leaving the nudge off). detectUncommittedTurn still covers a bash-only
  // turn that never committed anything.
  if (onlyTool === "bash") return null;
  if (!state.assistantText) return null;
  const text = state.assistantText;
  // Fire only on a FIRST-PERSON deferred self-action — the model teeing up
  // its own next step and stopping ("I'll edit it next", "Next, I'll run the
  // tests"). PLANNING_FUTURE_PROMISE already captures the first-person forms.
  //
  // HE-6 (class fix): a bare sentence-leading continuation cue is NOT enough.
  // A completed research/web_search deliverable naturally ends with an
  // ADVISORY tail addressed to the USER ("Next steps: compare quarterly",
  // "Next: monitor trends") — a delivered result, not a stall. Those have no
  // first-person subject, so requiring a continuation cue to introduce the
  // model's OWN action drops the whole false-nag class regardless of which
  // past-tense report verb (Researched/Compiled/Analyzed/…) opens the reply —
  // which is why enumerating opener or action vocabulary kept leaking.
  const cue = CONTINUATION_CUE_AT_SENTENCE_START.exec(text);
  const cueLeadsToSelfAction = cue !== null
    && FIRST_PERSON_INTENT_AFTER_CUE.test(text.slice(cue.index, cue.index + 48));
  if (!PLANNING_FUTURE_PROMISE.test(text) && !cueLeadsToSelfAction) {
    return null;
  }
  return { kind: "single-action-stop", instruction: SINGLE_ACTION_STOP_INSTRUCTION };
}

/**
 * User enumerated N steps; the model completed step M < N and yielded. This
 * is the harness compensating for models that, unlike Claude, hand control
 * back after each committing step instead of marching through the whole list.
 * Keyed on the model's own "Step M" label (lowest-false-positive signal) and
 * the user's enumerated step count — so a model that finishes every step in
 * one turn (its reply names the last step) never trips it.
 */
export function detectIncompleteMultiStep(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null; // still working
  if (!state.assistantText) return null;
  const total = state.enumeratedSteps ?? 0;
  if (total < 2) return null;
  if (isWaitingOnUser(state.assistantText)) return null;
  const claimed = highestClaimedStep(state.assistantText);
  if (claimed === 0 || claimed >= total) return null;
  return { kind: "incomplete-multistep", instruction: INCOMPLETE_MULTISTEP_INSTRUCTION };
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
