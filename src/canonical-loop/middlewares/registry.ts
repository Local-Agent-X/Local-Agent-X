/**
 * Default canonical-loop middleware stack.
 *
 * Order matters — copied from the universal-coverage order documented in
 * docs/runagent-caller-inventory.md "Legacy-loop middleware coverage" so the
 * canonical safety stack fires in the same sequence the three legacy loops
 * use:
 *
 *   beforeTurn:           mid-turn-stale, open-steps
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
 *
 * ── Ordering is DECLARATIVE ─────────────────────────────────────────────────
 * The emitted stack order is no longer encoded by array position. Each entry
 * below carries an explicit `order` number; `getDefaultMiddlewareStack()`
 * returns the entries sorted ascending by `order`. Orders are spaced by 10 so
 * a new middleware slots in at (say) 45 without renumbering its neighbours, and
 * every order is unique so the emitted sequence is independent of sort
 * stability. The per-entry rationale that used to explain "why this sits here"
 * now lives on the entry it describes. To reorder, change a number — you do not
 * move a line past paragraphs of unrelated comments.
 *
 * The order VALUES below reproduce the exact legacy hand-ordered sequence;
 * registry.test.ts's EXACT-ORDER LOCK freezes that sequence by name.
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
import { autoBuildAppMiddleware } from "./auto-build-app.js";
import { verifyGateMiddleware } from "./verify-gate.js";
import { postEditDiagnosticsMiddleware } from "./post-edit-diagnostics.js";
import { cleanupVerifyMiddleware } from "./cleanup-verify.js";
import { instructionLedgerMiddleware } from "./instruction-ledger.js";
import { instructionAuditMiddleware } from "./instruction-audit.js";

/** One declarative stack entry: the middleware plus its explicit sort key. */
interface StackEntry {
  order: number;
  mw: CanonicalMiddleware;
}

/**
 * The declarative default stack. `order` (ascending) is the single source of
 * truth for firing sequence — array position here is irrelevant. Every order
 * is unique so the emitted sequence never depends on sort stability.
 */
const DEFAULT_STACK: StackEntry[] = [
  { order: 10, mw: midTurnStaleMiddleware },
  // Strips an uninvited per-call `theme` from office tools before dispatch
  // (house style is the default unless the user asked for a look).
  { order: 20, mw: officeThemeGuardMiddleware },
  // Turn 0 beforeTurn only — parses the kickoff message into the per-op
  // instruction ledger (explicit user run constraints) so the persistence
  // guards below and pre-dispatch capability gating can read it from the
  // very first dispatch. Fail-open: an extractor fault records an EMPTY
  // ledger, which constrains nothing.
  { order: 30, mw: instructionLedgerMiddleware },
  { order: 40, mw: loopDetectionMiddleware },
  // All lanes — content-repetition breaker: the model emitting the same
  // visible answer turn after turn. Sibling to loop-detection (which watches
  // tool-call identity and can't see a text loop). Two-strike nudge→abort;
  // aborts on every lane because repeated identical prose has no legit form.
  { order: 50, mw: repeatOutputMiddleware },
  { order: 60, mw: hallucinationCheckMiddleware },
  { order: 70, mw: actionClaimMiddleware },
  // Interactive chat — catches a final summary that CREDITS the result with a
  // tool/model/service it never used (action-claim is worker-only + checks
  // action verbs, not attribution). Phrase-gated → model-graded; retractable.
  { order: 80, mw: attributionClaimMiddleware },
  // All lanes — memory and prior assistant prose are not evidence for
  // runtime/security/policy causality. Require a fresh diagnostic read or an
  // explicitly uncertain answer before a definitive claim reaches the user.
  { order: 90, mw: operationalClaimMiddleware },
  // All lanes — when the user asks for repo/harness implementation direction,
  // docs and memory are not enough. Require current code inspection before a
  // concrete "we should implement/change/wire X" recommendation reaches the
  // user.
  { order: 100, mw: codebaseAdviceMiddleware },
  // Interactive + worker — in UNRESTRICTED file mode, a tool-less turn that
  // refuses a file action on a guessed restriction ("outside the sandbox")
  // without ever calling `read` gets a grounding nudge. Runs BEFORE
  // tool-search-nudge so this file-permission case gets "you're permitted,
  // call read" instead of the (useless-for-an-eager-read) "go search" nudge.
  { order: 110, mw: falseRefusalMiddleware },
  // All lanes (incl. interactive chat) — forces a tool_search when the model
  // declines a capability with zero tool calls, before the denial reaches the
  // user. Runs before premature-completion so a "no tool" denial gets the
  // search nudge, not the do-the-work nudge.
  { order: 120, mw: toolSearchNudgeMiddleware },
  // All lanes — when the task is a codebase-wide sweep ("fix every X", "remove
  // all references to Y") but the model wraps up tool-lessly without ever
  // running grep/glob, force ONE enumeration pass first. Runs after
  // tool-search-nudge (a capability denial gets the search nudge) and before
  // premature-completion ("enumerate the surface" beats the generic "do the
  // work" nudge for an under-scoped sweep).
  { order: 130, mw: broadSweepNudgeMiddleware },
  { order: 140, mw: prematureCompletionMiddleware },
  // All lanes — edited source but never reached a clean build/type-check/test
  // before wrapping up → nudge (gently if nothing verified it, sharply if a
  // verify RAN and FAILED). Like cleanup-verify, NOT worker-only: a coding task
  // arrives most often as interactive chat where the user trusts "done". Runs
  // after premature-completion (they key on opposite signals: no-commit vs a
  // committed source edit, so they don't contend).
  { order: 150, mw: verifyGateMiddleware },
  // All lanes — the SEARCH-verification sibling of verify-gate: on a
  // removal/cleanup sweep ("remove all X", "finish cleaning up Y"), nudge once
  // when the model reports it done without a grep ever coming back empty, and
  // keep the outcome honest (an unconfirmed cleanup records `partial`). A
  // passing build doesn't prove a ref is gone — dead refs in comments/docs/
  // strings compile fine — so this checks the model's own clean-search
  // evidence, not the build. Runs after verify-gate so an edited-but-unbuilt
  // worker still gets the build nudge first.
  { order: 160, mw: cleanupVerifyMiddleware },
  // All lanes — wrap-up audit of the final answer against the instruction
  // ledger: an unmet obligation ("commit when done" with no commit seen) or
  // a forbidden-capability tool that leaked past pre-dispatch gating each
  // nudge once. A deterministic ledger check, so it runs with the other
  // wrap-up gates BEFORE refute-completion's LLM panel. Fail-open: no ledger
  // or no matching constraint → continue.
  { order: 170, mw: instructionAuditMiddleware },
  // Worker ops only — a semantic last-resort completion check: when a worker
  // claims done (text, no tools) AFTER committing work and none of the cheap
  // deterministic gates above nudged, fire an independent skeptic panel at the
  // done-claim and nudge once (with the skeptics' reasons) on a majority
  // refutation. Fail-open + fire-once; sits AFTER the deterministic gates so
  // the LLM panel only runs when they all passed. Disable: LAX_REFUTE_COMPLETION=0.
  { order: 180, mw: refuteCompletionMiddleware },
  { order: 190, mw: openStepsMiddleware },
  // Interactive chat only — forces one more turn when a browser-driving turn
  // ends by punting the obstruction back to the user while the page is still
  // open (the chat analogue of premature-completion, which is worker-only).
  { order: 200, mw: browserHandoffMiddleware },
  { order: 210, mw: selfCheckMiddleware },
  { order: 220, mw: postTurnDetectorMiddleware },
  { order: 230, mw: autoBuildAppMiddleware },
  { order: 240, mw: postCommitMiddleware },
  // All lanes — after a turn's dispatch edited TS/JS source, diff language-intel
  // diagnostics against the op's per-file baseline and inject only the NEW
  // errors as same-turn feedback, so the model fixes "your edit broke X" now
  // instead of at build time. Sits after post-commit (a landed commit's wrap-up
  // nudge wins first) and before dead-end. Fail-open; disable with
  // LAX_POST_EDIT_DIAGNOSTICS=0.
  { order: 245, mw: postEditDiagnosticsMiddleware },
  { order: 250, mw: deadEndMiddleware },
  // All lanes (incl. interactive) — same-tool same-error spiral breaker.
  { order: 260, mw: repeatFailureMiddleware },
];

export function getDefaultMiddlewareStack(): CanonicalMiddleware[] {
  return [...DEFAULT_STACK]
    .sort((a, b) => a.order - b.order)
    .map(entry => entry.mw);
}
