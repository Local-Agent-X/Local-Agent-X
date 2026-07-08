// Verify-gate — a worker edited source code this run but never ran the
// project's build / type-check / test before wrapping up. Compiling or
// saving a file is not proof the change works; an autonomous worker that
// ships unverified edits is the silent-failure case the loop has no other
// guard for. Track edit-vs-verify evidence across the op, then nudge once at
// wrap-up if source changed and nothing verified it.
//
// Logic lives here (pure, testable over normalized actions); the canonical
// middleware in src/canonical-loop/middlewares/verify-gate.ts feeds it the
// per-turn tool calls and clears state on op-terminal.
//
// Also carries the test-deletion tripwire: the orchestrator build-verify gate
// runs the op's EDITED tests, but a DELETED test isn't run — so "delete the
// failing test" is an invisible path to green the gate can't see. This tracks
// test-file deletions and exposes a pure decision (decideDeletedTest); the
// dodge-vs-legit-cleanup judgment itself is an async LLM call in the middleware.

import { isTestFile } from "./build-command.js";
import { evaluateClaimGrounding, type EvidenceKind } from "./claim-grounding.js";

/** Normalized view of one tool call + its dispatch outcome for a turn. */
export interface VerifyTurnAction {
  tool: string;
  /** file_path for edit/write tools, when present. */
  filePath?: string;
  /** command string for bash, when present. */
  command?: string;
  /** Shell cwd, when the executor injected one. */
  cwd?: string;
  /** Dispatch status. Mirrors the canonical ToolDispatchStatus union (kept as
   *  a local literal so this pure guard doesn't reach up into canonical-loop). */
  status?: "ok" | "error" | "blocked" | "declined" | "timeout" | "cancelled";
}

export interface VerifyGateState {
  /** A source file was created/edited at some point this op. */
  editedSource: boolean;
  /** Distinct source-file paths edited this op, insertion-ordered. Read by the
   *  orchestrator build-verify gate to locate the project to build (walk up to
   *  the nearest build manifest). Capped so a pathological run can't grow it
   *  unbounded; the cap only limits which dirs we'd detect, never correctness. */
  editedPaths: string[];
  /** A verify command ran OK (exit 0) AFTER the most recent source edit. */
  verifiedSinceEdit: boolean;
  /** A verify command ran and FAILED (non-zero exit → status "error") after the
   *  most recent source edit, with no clean verify since. The model HAS the
   *  error list and must not report the work done over it. Cleared by a clean
   *  verify or a fresh edit (a re-edit is treated as a fix attempt). */
  verifyFailedSinceEdit: boolean;
  /** Fire-once cap for the gentle "you never verified" nudge. */
  firedNoVerify: boolean;
  /** Fire count for the stronger "your build is RED" nudge. It may fire even
   *  after the gentle one — a failing build is new, actionable information — but
   *  is bounded so an unfixable build doesn't nag forever (dead-end / repeat-
   *  failure own the spiral past this point; the outcome label still records
   *  partial regardless). */
  failNudges: number;
  /** Test files the op DELETED (via delete_file). The build-verify gate can't
   *  see these — a deleted test isn't run — so they're tracked to nudge against
   *  deleting a test to dodge a red suite. */
  deletedTestPaths: string[];
  /** Fire-once cap for the deleted-test nudge. */
  firedDeletedTest: boolean;
}

export function createVerifyGateState(): VerifyGateState {
  return {
    editedSource: false,
    editedPaths: [],
    verifiedSinceEdit: false,
    verifyFailedSinceEdit: false,
    firedNoVerify: false,
    failNudges: 0,
    deletedTestPaths: [],
    firedDeletedTest: false,
  };
}

/** Cap on tracked edited paths. Far above any real op's distinct-file count;
 *  a backstop against an adversarial loop, not a functional limit. */
const MAX_EDITED_PATHS = 200;

/** Past this many "build is RED but you're wrapping up anyway" nudges, the model
 *  has demonstrably failed to fix it from here — stop nudging and let the spiral
 *  breakers (dead-end / repeat-failure) and the partial outcome label take over. */
const MAX_FAIL_NUDGES = 2;

/** Tools that change file contents on disk. self_edit is excluded — it runs
 *  its own build subprocess on LAX's own source, so nudging it is noise.
 *  Exported so the open-steps plan-seed keys "the op wrote a file" off the SAME
 *  definition instead of a second drifting copy. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write", "edit", "edit_lines", "multi_edit", "bulk_replace",
]);

/** Extensions that have a meaningful compile / type-check / test step. Pure
 *  data files (.json/.md/.css/.html/.yaml) are intentionally excluded — editing
 *  only those shouldn't demand a build. Deliberately BROADER than language-intel's
 *  TS_FAMILY_EXT_RE (src/language-intel/types.ts) — this spans many languages —
 *  but the TS-family subset here must stay a superset of that constant. */
const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|kts|scala|m|mm)$/i;

/** Shell commands that constitute a real verification pass. Conservative: a
 *  false positive only SUPPRESSES the nudge, which is the safe direction.
 *  `python -m unittest`/`-m pytest` (incl. intervening flags like `-W ignore`)
 *  is the STDLIB test runner — it needs no pip install, so it's how a model
 *  verifies a Python task. Without it the gate was blind to Python testing:
 *  a passing `python -m unittest` wasn't credited (honest verify → spurious
 *  nudge + partial label) and a FAILING one didn't trip the sharp "build is RED"
 *  nudge (the failure went invisible). `pytest` bare already covers `-m pytest`. */
const VERIFY_CMD_RE =
  /\b(tsc|vitest|jest|mocha|pytest|mypy|pyright|ruff|eslint|(?:python[0-9.]*|py)\s+-m\s+(?:unittest|pytest)|cargo\s+(build|test|check|clippy)|go\s+(build|test|vet)|gradle|mvn|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|typecheck|type-check|lint|check|tsc))\b/i;

const HTTP_SMOKE_CMD_RE =
  /\b(curl(?:\.exe)?|wget|Invoke-WebRequest|iwr)\b[\s\S]*(\/apps\/|\/api\/connectors\/)/i;

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXT_RE.test(filePath);
}

function normPath(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

function workspaceAppSlug(filePath: string): string | null {
  const m = normPath(filePath).match(/(?:^|\/)workspace\/apps\/([^/]+)/);
  return m?.[1] ?? null;
}

function verifyTargetsEditedApp(command: string, cwd: string | undefined, editedPaths: readonly string[]): boolean {
  const appSlugs = Array.from(new Set(editedPaths.map(workspaceAppSlug).filter(Boolean))) as string[];
  if (appSlugs.length === 0) return true;

  const haystack = normPath(`${cwd ?? ""}\n${command}`);
  if (HTTP_SMOKE_CMD_RE.test(command)) {
    return appSlugs.some(slug =>
      haystack.includes(`/apps/${slug}`) ||
      haystack.includes(`/api/connectors/`),
    );
  }

  return appSlugs.some(slug =>
    haystack.includes(`/workspace/apps/${slug}`) ||
    haystack.includes(`\\workspace\\apps\\${slug}`.replace(/\\/g, "/")) ||
    haystack.includes(`/apps/${slug}`),
  );
}

/** Fold one turn's actions into the running edit-vs-verify state. Actions are
 *  in tool-call order, so an edit-then-verify within one turn lands verified and
 *  a verify-then-edit correctly invalidates it (the newer edit wins). */
export function noteVerifyEvidence(
  actions: VerifyTurnAction[],
  state: VerifyGateState,
): void {
  for (const a of actions) {
    if (EDIT_TOOLS.has(a.tool) && a.filePath && isSourceFile(a.filePath)) {
      state.editedSource = true;
      if (
        !state.editedPaths.includes(a.filePath) &&
        state.editedPaths.length < MAX_EDITED_PATHS
      ) {
        state.editedPaths.push(a.filePath);
      }
      // A fresh edit invalidates both a prior pass AND a prior failure — the
      // edit is presumed a fix attempt that must be re-verified from scratch.
      state.verifiedSinceEdit = false;
      state.verifyFailedSinceEdit = false;
    }
    if (
      a.tool === "bash" &&
      a.command &&
      state.editedSource &&
      (VERIFY_CMD_RE.test(a.command) || HTTP_SMOKE_CMD_RE.test(a.command)) &&
      verifyTargetsEditedApp(a.command, a.cwd, state.editedPaths)
    ) {
      // Exit 0 → ok; any failure flavor (error / blocked / declined / timeout
      // — all of which arrived as "error" before the dispatch boundary carried
      // the envelope flavor) → failed verify. A cancelled/unknown status
      // carries no verdict, so it's left untouched.
      if (a.status === "ok") {
        state.verifiedSinceEdit = true;
        state.verifyFailedSinceEdit = false;
      } else if (a.status !== undefined && a.status !== "cancelled") {
        state.verifyFailedSinceEdit = true;
        state.verifiedSinceEdit = false;
      }
    }
    // Test-deletion tripwire: delete_file on a test path (or a bash `rm` of one).
    // A deleted test is invisible to the build-verify gate — it only runs EDITED
    // tests — so "delete the failing test" would otherwise go green unseen.
    const deletedTest =
      a.tool === "delete_file" && a.filePath && isTestFile(a.filePath)
        ? a.filePath
        : a.tool === "bash" && a.command
          ? a.command.match(/\brm\b[^|;&]*?([^\s|;&]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/i)?.[1] ?? null
          : null;
    if (
      deletedTest &&
      !state.deletedTestPaths.includes(deletedTest) &&
      state.deletedTestPaths.length < MAX_EDITED_PATHS
    ) {
      state.deletedTestPaths.push(deletedTest);
    }
  }
}

/** Record an authoritative verify verdict the ORCHESTRATOR ran itself (the
 *  build-verify gate runs the project's build/type-check between turns), rather
 *  than inferring one from the model's own bash calls. The orchestrator chose
 *  the command, so it sets the verdict directly: a clean run satisfies the edit,
 *  a failed run marks the project red. No-op if nothing was edited. */
export function recordExternalVerify(state: VerifyGateState, passed: boolean): void {
  if (!state.editedSource) return;
  state.verifiedSinceEdit = passed;
  state.verifyFailedSinceEdit = !passed;
}

/** Evidence adapter for the canonical claim-grounding table. The verify-gate
 * owns detection of edits and build/test commands; claim-grounding owns the
 * policy that a source done-claim needs build-clean evidence. */
export function sourceDoneEvidence(state: VerifyGateState): EvidenceKind[] {
  return state.editedSource && state.verifiedSinceEdit ? ["build-clean"] : [];
}

/** Language-service signal at wrap-up, fed by the canonical middleware from
 *  post-edit-diagnostics' per-op state (src/canonical-loop/middlewares/
 *  post-edit-diagnostics.ts). Deliberate weighting, mirroring the "lsp-clean"
 *  EvidenceKind comment in claim-grounding.ts:
 *  - `outstanding` (introduced type errors unresolved on edited files) is
 *    STRONG negative evidence — same tier as a verify that ran and FAILED.
 *  - `clean` (every edited TS/JS file's diagnostics clean) is WEAK positive
 *    evidence — it only softens the gentle nudge's tone and NEVER substitutes
 *    for a build/test run or grounds a source-done claim. */
export interface LspSignal {
  outstanding: boolean;
  clean: boolean;
}

const NO_LSP_SIGNAL: LspSignal = { outstanding: false, clean: false };

const NUDGE_NEVER_VERIFIED =
  "You edited source files this run but haven't run the project's build, " +
  "type-check, or tests since the last change. Compiling or saving is not " +
  "the same as working — verify before you finish: run the project's " +
  "build/type-check/tests (e.g. the build or test script in package.json, " +
  "`tsc --noEmit`, `python -m unittest`, `pytest`, `cargo test`, `go test`) and fix anything it " +
  "surfaces. If you genuinely can't run it from here, say so explicitly " +
  "instead of reporting the work as done.";

/** The gentle nudge with the lsp-clean acknowledging clause: same ask, softer
 *  tone — the language service says the edited files type-check, which is
 *  honest partial credit, but type-clean isn't run-clean so the build/test
 *  demand stands in full. */
const NUDGE_NEVER_VERIFIED_LSP_CLEAN =
  "Your edited files' types check clean, but run the build/tests — type-clean " +
  "isn't run-clean. You edited source files this run and no build, type-check, " +
  "or test has run since the last change: run the project's build/type-check/tests " +
  "(e.g. the build or test script in package.json, `tsc --noEmit`, `pytest`, " +
  "`cargo test`, `go test`) and fix anything it surfaces. If you genuinely can't " +
  "run it from here, say so explicitly instead of reporting the work as done.";

/** Sharp path for outstanding INTRODUCED type errors: the post-edit language
 *  service already showed the model these errors when its edits created them,
 *  and they are still unresolved at wrap-up — equivalent to a verify that ran
 *  and failed, so it shares NUDGE_BUILD_RED's tier (and fail-nudge bound). */
const NUDGE_LSP_RED =
  "STOP: your edits this run INTRODUCED type errors that are still unresolved — " +
  "the language service reports new compile/type errors on files you edited that " +
  "were not present before your changes (they were shown to you when they " +
  "appeared). Do NOT report this as done, complete, or working while they stand. " +
  "Fix every one of those introduced type errors, then run the project's " +
  "build/type-check to confirm it's clean. If you genuinely cannot fix them from " +
  "here, say so plainly and report exactly which errors remain — never claim " +
  "success over type errors your own edits introduced.";

const NUDGE_BUILD_RED =
  "STOP: your last build/type-check/test run FAILED — it exited with errors and " +
  "you edited source this run, so the project is currently broken. Do NOT report " +
  "this as done, complete, or working while it's red. Read the errors it printed, " +
  "fix every one, and re-run the same command until it passes clean. If you " +
  "genuinely cannot make it pass from here, say so plainly and report exactly " +
  "which errors remain — never claim success over a failing build.";

export const nudgeDeletedTest = (paths: readonly string[]): string =>
  `You deleted test file(s): ${paths.join(", ")}. Deleting or skipping a test to make the ` +
  "suite pass is NOT allowed — the build-verify gate only runs EDITED tests, so a test you " +
  "removed is invisible to it. If the test was failing, restore it and fix the underlying code " +
  "(or the test's wrong expectation). If it is genuinely obsolete or worthless (e.g. it only " +
  "asserts its own mocks), don't just drop coverage — replace it with a REAL test that exercises " +
  "the current behavior. If you truly believe removal is correct, say so explicitly and explain " +
  "why so the user can decide — never remove a test silently to go green.";

/** Best-guess path of the code a test file exercises: strip the `.test`/`.spec`
 *  infix, keep the extension. `src/foo.test.ts` → `src/foo.ts`,
 *  `a/b.spec.tsx` → `a/b.tsx`. A heuristic — a `__tests__/` sibling won't map —
 *  so it's fed to the judge as a hint (subject-exists), never the sole decider. */
export function guessTestSubject(testPath: string): string {
  return testPath.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/i, "$2");
}

/** The verdict the test-deletion judge returns, or null when it was unavailable. */
export type TestDeletionVerdict = "dodge" | "legit-cleanup";

/**
 * Pure decision for a detected test deletion, given the judge's verdict. Kept
 * out of `checkVerifyGate` (which is sync) because the verdict comes from an
 * async LLM call in the middleware; this stays pure + unit-testable.
 *
 * - `legit-cleanup` (user-directed or the subject code was removed) → suppress
 *   the nudge, don't demote the label.
 * - `dodge` (a live-code test deleted to go green) → nudge once + demote.
 * - `null` (judge unavailable) → FAIL SAFE to the prior blanket behavior: fire
 *   the advisory nudge, but leave the label alone (an unconfirmed dodge is not a
 *   demotion). `dodge` is only ever true on a CONFIRMED dodge.
 */
export function decideDeletedTest(
  stillDeleted: readonly string[],
  verdict: TestDeletionVerdict | null,
  alreadyFired: boolean,
): { nudge: string | null; dodge: boolean } {
  if (stillDeleted.length === 0) return { nudge: null, dodge: false };
  const shouldNudge = verdict !== "legit-cleanup";
  return {
    nudge: shouldNudge && !alreadyFired ? nudgeDeletedTest(stillDeleted) : null,
    dodge: verdict === "dodge",
  };
}

/** Evaluate at wrap-up. Two tiers: a gentle one-shot nudge when source changed
 *  but nothing verified it, and a stronger (re-fireable, bounded) nudge when a
 *  verify actually RAN and FAILED — the model has the errors and is wrapping up
 *  over them anyway, the exact ship-broken-and-claim-done failure.
 *
 *  The optional language-service signal (fed by the middleware) refines both
 *  tiers WITHOUT changing their structure: outstanding introduced type errors
 *  join the sharp path (same fail-nudge bound as a failed verify — the model
 *  HAS the error list); lsp-clean only swaps the gentle nudge's wording for
 *  the acknowledging variant. A grounded clean verify still silences
 *  everything — real build evidence outranks the (possibly stale) LSP state. */
export function checkVerifyGate(
  state: VerifyGateState,
  lsp: LspSignal = NO_LSP_SIGNAL,
): { nudge: string | null } {
  // The deleted-test tripwire is handled in the middleware (it needs an async
  // LLM judge to tell a dodge from legit cleanup); this stays edit/verify-only.
  if (!state.editedSource) return { nudge: null };

  const verdict = evaluateClaimGrounding("source-done", sourceDoneEvidence(state));
  if (verdict.grounded) return { nudge: null };

  // Sharp tier: a verify that ran and failed speaks with the exact command's
  // voice, so it wins over the LSP wording; outstanding introduced type errors
  // are its equivalent when no verify ran. Both share one bounded counter.
  if (state.verifyFailedSinceEdit || lsp.outstanding) {
    if (state.failNudges >= MAX_FAIL_NUDGES) return { nudge: null };
    state.failNudges += 1;
    return { nudge: state.verifyFailedSinceEdit ? NUDGE_BUILD_RED : NUDGE_LSP_RED };
  }

  if (!state.firedNoVerify) {
    state.firedNoVerify = true;
    return { nudge: lsp.clean ? NUDGE_NEVER_VERIFIED_LSP_CLEAN : NUDGE_NEVER_VERIFIED };
  }
  return { nudge: null };
}

/** Outcome-label verdict (read by decide-outcome): the op edited source but
 *  never reached a clean verify — whether it never ran one or ran one that
 *  failed. "Done" over an unverified edit is a partial, not a clean. */
export function opEditedSourceUnverified(state: VerifyGateState): boolean {
  return state.editedSource && !evaluateClaimGrounding("source-done", sourceDoneEvidence(state)).grounded;
}
