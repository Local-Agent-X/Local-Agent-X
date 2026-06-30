/**
 * Default canonical-loop middleware stack.
 *
 * Order matters — copied from the universal-coverage order documented in
 * docs/runagent-caller-inventory.md "Legacy-loop middleware coverage" so the
 * canonical safety stack fires in the same sequence the three legacy loops
 * use:
 *
 *   beforeTurn:           mid-turn-stale, force-tool-use (codex), open-steps
 *                         (turn-0 plan seed on agent/background lanes)
 *   afterModelCall:       loop-detection, hallucination-check, action-claim,
 *                         tool-search-nudge (all lanes — forces a tool_search
 *                         when the model declines a capability tool-lessly),
 *                         premature-completion (worker ops only — forces one
 *                         more turn when a non-chat op ends tool-lessly with
 *                         nothing committed; runs AFTER action-claim so a
 *                         claim-mismatch nudge wins first), open-steps
 *                         (forces continuation when the model left declared
 *                         task-list steps unfinished; runs on interactive too,
 *                         its open-tasks signal is safe for chat), browser-handoff
 *                         (interactive chat only — forces continuation when a
 *                         browser-driving turn punts the obstruction back to the
 *                         user with the page still open), self-check,
 *                         post-turn-detector, auto-build-app
 *                         (anthropic, runs AFTER post-turn-detector so the
 *                         detector sees the original empty-toolCalls state
 *                         before auto-build mutates it)
 *   afterToolExecution:   post-commit, dead-end, repeat-failure (ALL lanes —
 *                         same-tool same-error spiral breaker; nudge at 3,
 *                         abort at 5)
 *
 * Each middleware's `when` predicate gates per-provider extras at registration
 * walk time — `when:false` middlewares are skipped on every hook.
 */
import type { CanonicalMiddleware } from "./types.js";
import { loopDetectionMiddleware } from "./loop-detection.js";
import { deadEndMiddleware } from "./dead-end.js";
import { postCommitMiddleware } from "./post-commit.js";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { actionClaimMiddleware } from "./action-claim.js";
import { attributionClaimMiddleware } from "./attribution-claim.js";
import { toolSearchNudgeMiddleware } from "./tool-search-nudge.js";
import { falseRefusalMiddleware } from "./false-refusal.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { openStepsMiddleware } from "./open-steps.js";
import { browserHandoffMiddleware } from "./browser-handoff.js";
import { selfCheckMiddleware } from "./self-check.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { forceToolUseMiddleware } from "./force-tool-use.js";
import { autoBuildAppMiddleware } from "./auto-build-app.js";
import { verifyGateMiddleware } from "./verify-gate.js";

export function getDefaultMiddlewareStack(): CanonicalMiddleware[] {
  return [
    midTurnStaleMiddleware,
    forceToolUseMiddleware,
    // Strips an uninvited per-call `theme` from office tools before dispatch
    // (house style is the default unless the user asked for a look).
    officeThemeGuardMiddleware,
    loopDetectionMiddleware,
    hallucinationCheckMiddleware,
    actionClaimMiddleware,
    // Interactive chat — catches a final summary that CREDITS the result with a
    // tool/model/service it never used (action-claim is worker-only + checks
    // action verbs, not attribution). Phrase-gated → model-graded; retractable.
    attributionClaimMiddleware,
    // Interactive + worker — in UNRESTRICTED file mode, a tool-less turn that
    // refuses a file action on a guessed restriction ("outside the sandbox")
    // without ever calling `read` gets a grounding nudge. Runs BEFORE
    // tool-search-nudge so this file-permission case gets "you're permitted,
    // call read" instead of the (useless-for-an-eager-read) "go search" nudge.
    falseRefusalMiddleware,
    // All lanes (incl. interactive chat) — forces a tool_search when the model
    // declines a capability with zero tool calls, before the denial reaches the
    // user. Runs before premature-completion so a "no tool" denial gets the
    // search nudge, not the do-the-work nudge.
    toolSearchNudgeMiddleware,
    prematureCompletionMiddleware,
    // Worker edited source but never built/typechecked/tested before wrapping
    // up → nudge once. Runs after premature-completion (they're mutually
    // exclusive: that fires on no-commit, this on source-edit-committed).
    verifyGateMiddleware,
    openStepsMiddleware,
    // Interactive chat only — forces one more turn when a browser-driving turn
    // ends by punting the obstruction back to the user while the page is still
    // open (the chat analogue of premature-completion, which is worker-only).
    browserHandoffMiddleware,
    selfCheckMiddleware,
    postTurnDetectorMiddleware,
    autoBuildAppMiddleware,
    postCommitMiddleware,
    deadEndMiddleware,
    // All lanes (incl. interactive) — same-tool same-error spiral breaker.
    repeatFailureMiddleware,
  ];
}
