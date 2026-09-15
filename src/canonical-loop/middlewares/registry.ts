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
 *   afterModelCall:       loop-detection, action-claim,
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
 *                         post-turn-detector
 *   afterToolExecution:   dead-end, repeat-failure (ALL lanes —
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
import { repeatFailureMiddleware } from "./repeat-failure.js";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import { prematureCompletionMiddleware } from "./premature-completion.js";
import { openStepsMiddleware } from "./open-steps.js";
import { budgetLadderMiddleware } from "./budget-ladder.js";
import { midTurnStaleMiddleware } from "./mid-turn-stale.js";
import { verifyGateMiddleware } from "./verify-gate.js";
import { postEditDiagnosticsMiddleware } from "./post-edit-diagnostics.js";
import { appDesignGuardMiddleware } from "./app-design-guard.js";
import { externalChangeDiffMiddleware } from "./external-change-diff.js";
import { instructionLedgerMiddleware } from "./instruction-ledger.js";
import { thrashGuardMiddleware } from "./thrash-guard.js";

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
  { order: 140, mw: prematureCompletionMiddleware },
  // All lanes — edited source but never reached a clean build/type-check/test
  // before wrapping up → nudge (gently if nothing verified it, sharply if a
  // verify RAN and FAILED). Like cleanup-verify, NOT worker-only: a coding task
  // arrives most often as interactive chat where the user trusts "done". Runs
  // after premature-completion (they key on opposite signals: no-commit vs a
  // committed source edit, so they don't contend).
  { order: 150, mw: verifyGateMiddleware },
  { order: 190, mw: openStepsMiddleware },
  // Forced self-assessment at 25/50/75% of the iteration budget, and an
  // honest stop when two consecutive rungs learn nothing new. All lanes:
  // the budget wall that prompted it fires on interactive ops, and the
  // same no-progress spend happens unattended on worker ops.
  { order: 195, mw: budgetLadderMiddleware },
  // NOTE: auto-build-app (order 230) and post-commit (order 240) retired
  // 2026-07-10 — zero fires across the full persisted-op window (post-commit:
  // 33 days / 190 worker ops; auto-build-app: no log evidence and modern
  // anthropic models call build_app directly). agent-guards/post-commit.ts
  // survives — instruction-audit reuses checkPostCommit for its
  // commit-obligation evidence.
  // All lanes — after a turn's dispatch edited TS/JS source, diff language-intel
  // diagnostics against the op's per-file baseline and inject only the NEW
  // errors as same-turn feedback, so the model fixes "your edit broke X" now
  // instead of at build time. Sits before dead-end. Fail-open; disable with
  // LAX_POST_EDIT_DIAGNOSTICS=0.
  { order: 245, mw: postEditDiagnosticsMiddleware },
  // All lanes — each turn after tool dispatch, sweep the session's read files
  // for EXTERNAL on-disk changes (an editor save, another agent, a build) and
  // inject compact unified diffs against the session's cached snapshots, so
  // the model updates its mental model without a full re-read. Sits after
  // post-edit-diagnostics (a turn's own introduced-error feedback wins first)
  // and before dead-end. Fail-open; disable with LAX_EXTERNAL_CHANGE_DIFF=0.
  { order: 247, mw: externalChangeDiffMiddleware },
  // All lanes — an agent that writes app UI files straight into
  // workspace/apps/ skips build_app and therefore the design system it
  // injects; this hands the same rules over once per op. Sits after
  // post-edit-diagnostics so an introduced compile error wins first.
  // Fail-open; disable with LAX_APP_DESIGN_GUARD=0.
  { order: 248, mw: appDesignGuardMiddleware },
  { order: 250, mw: deadEndMiddleware },
  // All lanes (incl. interactive) — same-tool same-error spiral breaker.
  { order: 260, mw: repeatFailureMiddleware },
  // All lanes — settings-flip thrash breaker: protected-setting flips that
  // land right after tool failures, followed by more failures (the agent
  // routing AROUND a blocker instead of reporting it). Sibling to
  // repeat-failure, which can't see it: the flips SUCCEED and the failures
  // vary their error text, so no same-error spiral ever forms.
  { order: 270, mw: thrashGuardMiddleware },
];

export function getDefaultMiddlewareStack(): CanonicalMiddleware[] {
  return [...DEFAULT_STACK]
    .sort((a, b) => a.order - b.order)
    .map(entry => entry.mw);
}
