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

/** Normalized view of one tool call + its dispatch outcome for a turn. */
export interface VerifyTurnAction {
  tool: string;
  /** file_path for edit/write tools, when present. */
  filePath?: string;
  /** command string for bash, when present. */
  command?: string;
  status?: "ok" | "error" | "cancelled";
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
}

export function createVerifyGateState(): VerifyGateState {
  return {
    editedSource: false,
    editedPaths: [],
    verifiedSinceEdit: false,
    verifyFailedSinceEdit: false,
    firedNoVerify: false,
    failNudges: 0,
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
 *  its own build subprocess on LAX's own source, so nudging it is noise. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write", "edit", "edit_lines", "multi_edit",
]);

/** Extensions that have a meaningful compile / type-check / test step. Pure
 *  data files (.json/.md/.css/.html/.yaml) are intentionally excluded — editing
 *  only those shouldn't demand a build. */
const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|kts|scala|m|mm)$/i;

/** Shell commands that constitute a real verification pass. Conservative: a
 *  false positive only SUPPRESSES the nudge, which is the safe direction. */
const VERIFY_CMD_RE =
  /\b(tsc|vitest|jest|mocha|pytest|mypy|pyright|ruff|eslint|cargo\s+(build|test|check|clippy)|go\s+(build|test|vet)|gradle|mvn|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|typecheck|type-check|lint|check|tsc))\b/i;

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXT_RE.test(filePath);
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
      VERIFY_CMD_RE.test(a.command)
    ) {
      // Exit 0 → ok, non-zero → "error" (shell-tool maps the exit code). A
      // cancelled/unknown status carries no verdict, so it's left untouched.
      if (a.status === "ok") {
        state.verifiedSinceEdit = true;
        state.verifyFailedSinceEdit = false;
      } else if (a.status === "error") {
        state.verifyFailedSinceEdit = true;
        state.verifiedSinceEdit = false;
      }
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

const NUDGE_NEVER_VERIFIED =
  "You edited source files this run but haven't run the project's build, " +
  "type-check, or tests since the last change. Compiling or saving is not " +
  "the same as working — verify before you finish: run the project's " +
  "build/type-check/tests (e.g. the build or test script in package.json, " +
  "`tsc --noEmit`, `pytest`, `cargo test`, `go test`) and fix anything it " +
  "surfaces. If you genuinely can't run it from here, say so explicitly " +
  "instead of reporting the work as done.";

const NUDGE_BUILD_RED =
  "STOP: your last build/type-check/test run FAILED — it exited with errors and " +
  "you edited source this run, so the project is currently broken. Do NOT report " +
  "this as done, complete, or working while it's red. Read the errors it printed, " +
  "fix every one, and re-run the same command until it passes clean. If you " +
  "genuinely cannot make it pass from here, say so plainly and report exactly " +
  "which errors remain — never claim success over a failing build.";

/** Evaluate at wrap-up. Two tiers: a gentle one-shot nudge when source changed
 *  but nothing verified it, and a stronger (re-fireable, bounded) nudge when a
 *  verify actually RAN and FAILED — the model has the errors and is wrapping up
 *  over them anyway, the exact ship-broken-and-claim-done failure. */
export function checkVerifyGate(state: VerifyGateState): { nudge: string | null } {
  if (!state.editedSource || state.verifiedSinceEdit) return { nudge: null };

  if (state.verifyFailedSinceEdit) {
    if (state.failNudges >= MAX_FAIL_NUDGES) return { nudge: null };
    state.failNudges += 1;
    return { nudge: NUDGE_BUILD_RED };
  }

  if (!state.firedNoVerify) {
    state.firedNoVerify = true;
    return { nudge: NUDGE_NEVER_VERIFIED };
  }
  return { nudge: null };
}

/** Outcome-label verdict (read by decide-outcome): the op edited source but
 *  never reached a clean verify — whether it never ran one or ran one that
 *  failed. "Done" over an unverified edit is a partial, not a clean. */
export function opEditedSourceUnverified(state: VerifyGateState): boolean {
  return state.editedSource && !state.verifiedSinceEdit;
}
