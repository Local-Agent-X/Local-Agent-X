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
import { repeatOutputMiddleware } from "./repeat-output.js";
import { deadEndMiddleware } from "./dead-end.js";
import { postCommitMiddleware } from "./post-commit.js";
import { repeatFailureMiddleware } from "./repeat-failure.js";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import { hallucinationCheckMiddleware } from "./hallucination-check.js";
import { actionClaimMiddleware } from "./action-claim.js";
import { attributionClaimMiddleware } from "./attribution-claim.js";
import { operationalClaimMiddleware } from "./operational-claim.js";
import { codebaseAdviceMiddleware } from "./codebase-advice.js";
import { toolSearchNudgeMiddleware } from "./tool-search-nudge.js";
import { broadSweepNudgeMiddleware } from "./broad-sweep-nudge.js";
import { falseRefusalMiddleware } from "./false-refusal.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { refuteCompletionMiddleware } from "./refute-completion.js";
import { openStepsMiddleware } from "./open-steps.js";
import { browserHandoffMiddleware } from "./browser-handoff.js";
import { selfCheckMiddleware } from "./self-check.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { postTurnDetectorMiddleware } from "./post-turn-detector.js";
import { forceToolUseMiddleware } from "./force-tool-use.js";
import { autoBuildAppMiddleware } from "./auto-build-app.js";
import { verifyGateMiddleware } from "./verify-gate.js";
import { cleanupVerifyMiddleware } from "./cleanup-verify.js";

export function getDefaultMiddlewareStack(): CanonicalMiddleware[] {
  return [
    midTurnStaleMiddleware,
    forceToolUseMiddleware,
    // Strips an uninvited per-call `theme` from office tools before dispatch
    // (house style is the default unless the user asked for a look).
    officeThemeGuardMiddleware,
    loopDetectionMiddleware,
    // All lanes — content-repetition breaker: the model emitting the same
    // visible answer turn after turn. Sibling to loop-detection (which watches
    // tool-call identity and can't see a text loop). Two-strike nudge→abort;
    // aborts on every lane because repeated identical prose has no legit form.
    repeatOutputMiddleware,
    hallucinationCheckMiddleware,
    actionClaimMiddleware,
    // Interactive chat — catches a final summary that CREDITS the result with a
    // tool/model/service it never used (action-claim is worker-only + checks
    // action verbs, not attribution). Phrase-gated → model-graded; retractable.
    attributionClaimMiddleware,
    // All lanes — memory and prior assistant prose are not evidence for
    // runtime/security/policy causality. Require a fresh diagnostic read or an
    // explicitly uncertain answer before a definitive claim reaches the user.
    operationalClaimMiddleware,
    // All lanes — when the user asks for repo/harness implementation direction,
    // docs and memory are not enough. Require current code inspection before a
    // concrete "we should implement/change/wire X" recommendation reaches the
    // user.
    codebaseAdviceMiddleware,
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
    // All lanes — when the task is a codebase-wide sweep ("fix every X", "remove
    // all references to Y") but the model wraps up tool-lessly without ever
    // running grep/glob, force ONE enumeration pass first. Runs after
    // tool-search-nudge (a capability denial gets the search nudge) and before
    // premature-completion ("enumerate the surface" beats the generic "do the
    // work" nudge for an under-scoped sweep).
    broadSweepNudgeMiddleware,
    prematureCompletionMiddleware,
    // All lanes — edited source but never reached a clean build/type-check/test
    // before wrapping up → nudge (gently if nothing verified it, sharply if a
    // verify RAN and FAILED). Like cleanup-verify, NOT worker-only: a coding task
    // arrives most often as interactive chat where the user trusts "done". Runs
    // after premature-completion (they key on opposite signals: no-commit vs a
    // committed source edit, so they don't contend).
    verifyGateMiddleware,
    // All lanes — the SEARCH-verification sibling of verify-gate: on a
    // removal/cleanup sweep ("remove all X", "finish cleaning up Y"), nudge once
    // when the model reports it done without a grep ever coming back empty, and
    // keep the outcome honest (an unconfirmed cleanup records `partial`). A
    // passing build doesn't prove a ref is gone — dead refs in comments/docs/
    // strings compile fine — so this checks the model's own clean-search
    // evidence, not the build. Runs after verify-gate so an edited-but-unbuilt
    // worker still gets the build nudge first.
    cleanupVerifyMiddleware,
    // Worker ops only — a semantic last-resort completion check: when a worker
    // claims done (text, no tools) AFTER committing work and none of the cheap
    // deterministic gates above nudged, fire an independent skeptic panel at the
    // done-claim and nudge once (with the skeptics' reasons) on a majority
    // refutation. Fail-open + fire-once; sits AFTER the deterministic gates so
    // the LLM panel only runs when they all passed. Disable: LAX_REFUTE_COMPLETION=0.
    refuteCompletionMiddleware,
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
