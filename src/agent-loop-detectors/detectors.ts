// The six detector functions. Each is pure: takes TurnState, returns either
// a RetryInstruction (turn needs a nudge) or null (turn is fine).

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
  // Either way, if the op landed SUBSTANTIVE work we treat it as a recap,
  // not a plan, and skip the planning-only retry.
  //
  // The question THIS detector asks: did the model do real work on the USER'S
  // task, or only talk about it? That is exactly what the SUBSTANTIVE tally
  // encodes, so this is the one site of the three that reads
  // `committedSubstantiveWork` — detectUncommittedTurn and detectEvidenceStale
  // ask a broader question and read `committedWorkOrLedger` instead.
  //
  // The raw name-only tally is wrong here in BOTH directions, each verified
  // independently: it says "committed" for a turn whose only side effect was
  // the model's own task_* ledger, excusing the exact "wrote a plan, then
  // promised to act" reply this detector exists to catch, and it says "did
  // nothing" for a `pdf create` or a `browser` submit (isCommittingTool is
  // name-only and answers false for every arg-aware tool), nagging a genuine
  // recap of real work.
  //
  // This is the THIRD detector exposed to the arg-aware signal's noise, not a
  // detector outside it: `committedSubstantiveWork` is built from the same
  // per-call verdict that credits `browser` from a keyword regex over an `act`
  // instruction. Measured at the detectUncommittedTurn call site below. Here
  // the failure direction is a recap wrongly excused — a planning-only reply
  // that follows a mis-scored browser click keeps its nudge suppressed.
  const looksLikeRecap = COMPLETION_OPENER.test(text) || COMPLETION_PHRASE_AT_SENTENCE_START.test(text);
  if (looksLikeRecap && state.committedSubstantiveWork) return null;
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
 * Turn is ending (no tools this iteration) but the op has no committed side
 * effect on record at all. This catches the "ran exploratory tools, never
 * actually did the work" pattern.
 */
export function detectUncommittedTurn(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (state.iteration === 0) return null; // iter 0 with no tools is handled by planning-only + empty-response
  // The question THIS detector asks: is there ANY committed side effect on
  // record for this op? — NOT detectPlanningOnly's narrower "was it the USER'S
  // work?". So it reads `committedWorkOrLedger`, which the producer builds as
  // the UNION of the two op-level tallies (raw name-only ∪ arg-aware
  // substantive; see post-turn-detector.ts). Neither half answers this alone:
  //
  //   - Substantive alone: open-steps injects "lay them out with task_create"
  //     on turn 0 of every agent/background op, and this detector stack runs on
  //     worker ops (isWorkerOp — every non-interactive lane), so the ops it
  //     seeds are squarely inside what this judges. A read-only research op
  //     that takes that instruction (web_search / read / grep plus its own task
  //     ledger) has substantive == 0 BY DEFINITION, so this would fire and
  //     UNCOMMITTED_TURN_INSTRUCTION would tell the model to "call the tool
  //     that actually commits work (write/edit/send/save/pin/deploy)" on an op
  //     where the user asked for NO change — a nudge that op can never satisfy.
  //     open-steps reads the identical substantive predicate in this same stack
  //     with the OPPOSITE polarity — substantive == 0 is precisely when it
  //     STANDS DOWN — and committing-tool-check's opCommittedSubstantiveWork
  //     names the read-only "summarize these contracts" turn as the case that
  //     predicate exists to spare. This detector must not nudge the very op the
  //     rest of the stack stands down for.
  //   - Raw alone: the name-only check answers false for every arg-aware tool,
  //     so an op whose entire work was a `pdf create`, a `browser` submit or an
  //     `http_request` POST read as uncommitted and got nagged to commit work
  //     it had just committed. That was measured on real ops, and it also made
  //     this detector contradict detectPlanningOnly on the SAME TurnState —
  //     "did real work" there, "nothing committed" here.
  //
  // The union keeps the first stand-down (raw still supplies the task_* ledger)
  // and closes the second.
  //
  // HONEST LIMIT that remains: the read-only stand-down is still ACCIDENTAL —
  // it rides on task_* being committing BY NAME, so a read-only op that never
  // opens a task list is still nagged. Fixing that properly needs a "did the
  // user ask for a change?" signal, which does not exist yet.
  //
  // SECOND HONEST LIMIT — the input is noisy, and this is the one place the
  // measurement is written down. canonical-loop/middlewares/types.ts documents
  // the browser-regex false positives for the RAW tally's reader; the same
  // noise reaches here through the arg-aware half of the union, and through
  // both fields it reaches THREE detectors, not two: detectPlanningOnly via
  // `committedSubstantiveWork`, this one and detectEvidenceStale via
  // `committedWorkOrLedger`.
  //
  // Census of every `browser` call recorded in ~/.lax (3,681 calls — 2,154
  // session files plus 333 operations; 516 of them click / click_text / act,
  // 71 distinct action+target shapes): 9 shapes match
  // COMMITTING_BROWSER_ACTION_BUTTONS and 7 of those 9 are false positives
  // (13 of the 17 matching calls). Only `click "button[type=submit]"` and
  // `act "sign up for a new account"` were real. Calling that "a regex over
  // button text" understates the surface: 5 of the 9 matching shapes are
  // `act`, whose target is a free-form natural-language INSTRUCTION, not
  // button text — `act "Replace the purchase order number field with
  // 111222333"` is scored as committed work on the word `purchase`, and so is
  // `act "click Purchase Orders in the left navigation"`. `http_request`
  // carries a smaller version: committingArgReason treats an args record
  // holding `{_raw: …}` (how every adapter wraps JSON it could not parse) as
  // committing, so a malformed GET would stand these detectors down. That one
  // is mostly closed by rowCommittedWork's `resultStatus === "ok"` gate — a
  // call whose args never parsed errors — but it is not closed by design.
  //
  // SCOPE, stated so nobody reads it as an exemption: of the 822 arg-aware
  // (browser / http_request / pdf) tool-call summary rows on disk, 815 are
  // interactive-lane and 7 sit in a single `agent`-lane op — and all 7 are
  // `http_request`, not one a `browser` click. These detectors are
  // isWorkerOp-gated, so today the browser noise cannot reach them. That is a
  // SAMPLING ARTIFACT of this box, not a structural guarantee:
  // tools/audience-map.ts advertises http_request, browser and pdf to the
  // `spawned-agent` audience, so a worker op can call all three. Compounding
  // it, zero of the 4,398 summary rows on disk carry a `committing` field yet,
  // so for all existing history the arg-aware half silently degrades to the
  // name-only fallback; the noise arrives with the first worker op that
  // dispatches a browser click, not with a code change here.
  if (state.committedWorkOrLedger) return null;
  // Only nudge once per turn for this class; caller tracks the counter.
  return { kind: "uncommitted-turn", instruction: UNCOMMITTED_TURN_INSTRUCTION };
}

/**
 * Evidence counter flat for 2+ rounds AND the op has no committed side effect
 * on record. Prevents endless exploration.
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
  // The question THIS detector asks: with the evidence counter flat, has
  // ANYTHING at all been committed — or is the op purely spinning? Same
  // `committedWorkOrLedger` union as detectUncommittedTurn above, chosen for
  // the same reasons and carrying the same remaining limit; that comment is
  // the one place the argument is written out. The short version: this
  // detector judges the same agent/background ops open-steps seeds with a
  // task_create plan, so the substantive half alone would tell a read-only
  // research op, forever, to commit a change nobody asked for — while the raw
  // half alone is blind to `pdf` / `browser` / `http_request` and nagged ops
  // that had already committed their work.
  //
  // It also inherits the same NOISE, measured in full at that call site: the
  // arg-aware half credits `browser` from a keyword regex that in a census of
  // 3,681 real browser calls was a false positive on 7 of the 9 shapes it
  // matched, 5 of which were free-form `act` instructions rather than button
  // text. Here that only makes the detector stand down early — it can suppress
  // an evidence-stale nudge, never fire a spurious one.
  if (state.committedWorkOrLedger) return null;
  return { kind: "evidence-stale", instruction: EVIDENCE_STALE_INSTRUCTION };
}
