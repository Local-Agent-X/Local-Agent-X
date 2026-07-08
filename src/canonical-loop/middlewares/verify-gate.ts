/**
 * Verify-gate middleware — the op edited source code but never reached a clean
 * build / type-check / test before wrapping up. Accumulate edit-vs-verify
 * evidence after each turn's dispatch; at wrap-up (model ends tool-lessly with
 * text, same signal premature-completion keys on) nudge: gently when nothing
 * verified the edit, sharply when a verify actually RAN and FAILED.
 *
 * All lanes — like its search-verification sibling cleanup-verify, and unlike
 * the worker-progress guards, this is NOT worker-only. An autonomous coding task
 * ("rename X→Y", "remove all refs to Z", "fix this bug") arrives most often as
 * interactive chat, where the user trusts the "done" claim rather than re-running
 * the build themselves — exactly the case that needs the gate. The gate only
 * fires when source was actually edited, so a pure-conversation turn never trips
 * it. Still mutually exclusive with premature-completion in practice: that keys
 * on no-commit, this on a committed source edit.
 *
 * Detection logic lives in src/agent-guards/verify-gate.ts; this is the thin
 * canonical wiring.
 */
import { existsSync } from "node:fs";
import { type CanonicalMiddleware, type CanonicalLoopContext } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  noteVerifyEvidence,
  checkVerifyGate,
  createVerifyGateState,
  opEditedSourceUnverified as opEditedSourceUnverifiedState,
  recordExternalVerify,
  guessTestSubject,
  decideDeletedTest,
  SOURCE_VERIFY_REASON,
  type VerifyGateState,
  type VerifyTurnAction,
} from "../../agent-guards/index.js";
import {
  opEditedFilesLspClean,
  opHasOutstandingIntroducedErrors,
} from "./post-edit-diagnostics.js";
import { classifyTestDeletion } from "../../classifiers/test-deletion-classify.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { capabilityForbiddenForOp } from "../instruction-ledger/index.js";

/**
 * Outcome-label verdict (read by decide-outcome): the op edited source and never
 * reached a clean verify — it ran none, or ran one that failed. Reporting "done"
 * over an unverified edit records `partial`, not a rounded-up `clean`. Defaults
 * false for ops the gate never evaluated, so it only ever demotes a real case.
 */
export function opEditedSourceUnverified(opId: string): boolean {
  return opEditedSourceUnverifiedState(
    getMiddlewareState<VerifyGateState>(opId, "verify-gate", createVerifyGateState),
  );
}

/** Source-file paths the op edited (insertion-ordered). The orchestrator
 *  build-verify gate uses these to locate the project to build. */
export function opEditedSourcePaths(opId: string): string[] {
  return getMiddlewareState<VerifyGateState>(opId, "verify-gate", createVerifyGateState).editedPaths;
}

const TEST_DELETION_VERDICT_STATE = "test-deletion-verdict";

interface TestDeletionVerdictState {
  /** The judge CONFIRMED a dodge (a live-code test deleted to go green). Read by
   *  decide-outcome for the label. Only ever true on a confirmed dodge — a null
   *  (judge unavailable) or legit-cleanup leaves it false, so an op the judge
   *  couldn't confirm keeps its clean/partial labeling untouched. */
  dodge: boolean;
  /** The deletion set (sorted-joined) the current verdict was computed for.
   *  Memo key: re-judging an unchanged set each wrap-up turn would burn LLM
   *  calls for no new signal. Only a NON-null verdict is memoized, so a
   *  momentary judge outage retries next turn. */
  judgedFor: string;
}

/**
 * Outcome-label verdict (read by decide-outcome): the op deleted a test and the
 * LLM judge classified it a DODGE — a live-code test removed to dodge a red
 * suite, not user-directed or dead-test cleanup. Reporting "done" over a dodge
 * records `partial`. Defaults false, so ops with no deletion (or a legit /
 * unjudged one) keep their prior labeling.
 */
export function opDeletedTestDodge(opId: string): boolean {
  return getMiddlewareState<TestDeletionVerdictState>(
    opId,
    TEST_DELETION_VERDICT_STATE,
    () => ({ dodge: false, judgedFor: "" }),
  ).dodge;
}

/**
 * The deleted-test tripwire, model-graded. Fires the async LLM judge to tell a
 * dodge from legit cleanup, then returns the nudge (if any) and persists the
 * dodge verdict for the outcome label. Called at wrap-up from afterModelCall.
 *
 * Recovery-aware: a test that's been RESTORED (present on disk again) drops out
 * of the deletion set, so heeding the nudge clears both the nag and the label.
 */
async function evaluateDeletedTests(
  ctx: CanonicalLoopContext,
  state: VerifyGateState,
): Promise<string | null> {
  if (state.deletedTestPaths.length === 0) return null;

  const verdictState = getMiddlewareState<TestDeletionVerdictState>(
    ctx.op.id,
    TEST_DELETION_VERDICT_STATE,
    () => ({ dodge: false, judgedFor: "" }),
  );

  // A restored test is no longer a deletion — filter to those still absent.
  const stillDeleted = state.deletedTestPaths.filter((p) => !existsSync(resolveAgentPath(p)));
  if (stillDeleted.length === 0) {
    verdictState.dodge = false;
    return null;
  }

  const key = [...stillDeleted].sort().join("|");
  let verdict: "dodge" | "legit-cleanup" | null;
  if (verdictState.judgedFor === key) {
    // Unchanged deletion set already judged — reuse (memoized non-null verdict).
    verdict = verdictState.dodge ? "dodge" : "legit-cleanup";
  } else {
    const subjects = stillDeleted.map((t) => {
      const subjectGuess = guessTestSubject(t);
      return { test: t, subjectGuess, subjectExists: existsSync(resolveAgentPath(subjectGuess)) };
    });
    verdict = await classifyTestDeletion({
      userRequest: ctx.userMessage,
      deletedTests: stillDeleted,
      editedPaths: state.editedPaths,
      subjects,
    });
    // Only memoize a real verdict; a null (judge unavailable) leaves the label
    // undemoted and retries on the next wrap-up turn.
    if (verdict !== null) {
      verdictState.judgedFor = key;
      verdictState.dodge = verdict === "dodge";
    }
  }

  const { nudge } = decideDeletedTest(stillDeleted, verdict, state.firedDeletedTest);
  if (nudge) state.firedDeletedTest = true;
  return nudge;
}

/** Record the verdict of a build/type-check the ORCHESTRATOR ran itself into the
 *  op's edit/verify ledger, so the outcome label reads clean on a pass and
 *  partial on a failure — the same ledger the model's own verify writes to. */
export function recordOrchestratorVerify(opId: string, passed: boolean): void {
  recordExternalVerify(
    getMiddlewareState<VerifyGateState>(opId, "verify-gate", createVerifyGateState),
    passed,
  );
}

function buildActions(
  toolCalls: { toolCallId: string; tool: string; args: unknown }[],
  toolResults: { toolCallId: string; status?: VerifyTurnAction["status"] }[],
): VerifyTurnAction[] {
  const statusById = new Map(toolResults.map(tr => [tr.toolCallId, tr.status]));
  return toolCalls.map(tc => {
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const filePath =
      typeof args.file_path === "string" ? args.file_path
      : typeof args.path === "string" ? args.path
      : undefined;
    return {
      tool: tc.tool,
      filePath,
      command: typeof args.command === "string" ? args.command : undefined,
      cwd: typeof args._cwd === "string" ? args._cwd : undefined,
      status: statusById.get(tc.toolCallId),
    };
  });
}

export const verifyGateMiddleware: CanonicalMiddleware = {
  name: "verify-gate",

  afterToolExecution(ctx) {
    const state = getMiddlewareState<VerifyGateState>(
      ctx.op.id,
      "verify-gate",
      createVerifyGateState,
    );
    noteVerifyEvidence(buildActions(ctx.toolCalls, ctx.toolResults), state);
    return { kind: "continue" };
  },

  async afterModelCall(ctx) {
    // The verify NUDGE pushes "run the build/tests" — never against an explicit
    // user prohibition on running commands or editing ("don't run anything,
    // I'll verify myself"). Only the nudge is suppressed: the evidence accrual
    // in afterToolExecution above still runs, so the outcome LABEL
    // (opEditedSourceUnverified) stays honest. Fail-open: no ledger entry, no
    // suppression.
    if (
      capabilityForbiddenForOp(ctx.op, "shell") ||
      capabilityForbiddenForOp(ctx.op, "workspace-write")
    ) return { kind: "continue" };
    // Only evaluate at wrap-up: model ended the turn with text and no tool
    // calls. Mirrors premature-completion's wrap-up detection.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    const state = getMiddlewareState<VerifyGateState>(
      ctx.op.id,
      "verify-gate",
      createVerifyGateState,
    );

    // Deleted-test tripwire first (mirrors the old checkVerifyGate ordering): the
    // async LLM judge decides dodge vs legit cleanup, and a confirmed dodge also
    // demotes the outcome label via opDeletedTestDodge.
    const delNudge = await evaluateDeletedTests(ctx, state);
    if (delNudge) return { kind: "nudge", message: delNudge, reason: "verify-gate-test-deletion" };

    // Language-service signal from post-edit-diagnostics' per-op state.
    // Timing: that middleware (order 245) writes the state in its
    // afterToolExecution hook; this is a wrap-up afterModelCall on a turn with
    // ZERO tool calls (guarded above), so no afterToolExecution fires this
    // turn. The outstanding accessor RE-VERIFIES against the live language
    // service before answering, so an error fixed indirectly (different file,
    // or bash) never fires the sharp nudge on stale state. Outstanding
    // introduced errors sharpen the nudge; lsp-clean only softens its tone
    // and never substitutes for the build (see checkVerifyGate).
    const r = checkVerifyGate(state, {
      outstanding: await opHasOutstandingIntroducedErrors(ctx.op.id),
      clean: opEditedFilesLspClean(ctx.op.id),
    });
    if (r.nudge) return { kind: "nudge", message: r.nudge, reason: SOURCE_VERIFY_REASON };
    return { kind: "continue" };
  },
};
