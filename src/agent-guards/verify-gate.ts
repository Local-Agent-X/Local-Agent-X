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
  /** A verify command ran (ok) AFTER the most recent source edit. */
  verifiedSinceEdit: boolean;
  /** Fire-once cap — one nudge per op, matching the other wrap-up guards. */
  fired: boolean;
}

export function createVerifyGateState(): VerifyGateState {
  return { editedSource: false, verifiedSinceEdit: false, fired: false };
}

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

/** Fold one turn's actions into the running edit-vs-verify state. */
export function noteVerifyEvidence(
  actions: VerifyTurnAction[],
  state: VerifyGateState,
): void {
  for (const a of actions) {
    if (EDIT_TOOLS.has(a.tool) && a.filePath && isSourceFile(a.filePath)) {
      state.editedSource = true;
      state.verifiedSinceEdit = false; // a new edit invalidates a prior verify
    }
    if (
      a.tool === "bash" &&
      a.status === "ok" &&
      a.command &&
      VERIFY_CMD_RE.test(a.command)
    ) {
      if (state.editedSource) state.verifiedSinceEdit = true;
    }
  }
}

/** Evaluate at wrap-up. Returns a nudge once if source changed without a
 *  verification pass; null otherwise. */
export function checkVerifyGate(state: VerifyGateState): { nudge: string | null } {
  if (state.editedSource && !state.verifiedSinceEdit && !state.fired) {
    state.fired = true;
    return {
      nudge:
        "You edited source files this run but haven't run the project's build, " +
        "type-check, or tests since the last change. Compiling or saving is not " +
        "the same as working — verify before you finish: run the project's " +
        "build/type-check/tests (e.g. the build or test script in package.json, " +
        "`tsc --noEmit`, `pytest`, `cargo test`, `go test`) and fix anything it " +
        "surfaces. If you genuinely can't run it from here, say so explicitly " +
        "instead of reporting the work as done.",
    };
  }
  return { nudge: null };
}
