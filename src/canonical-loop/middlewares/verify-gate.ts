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
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  noteVerifyEvidence,
  checkVerifyGate,
  createVerifyGateState,
  opEditedSourceUnverified as opEditedSourceUnverifiedState,
  recordExternalVerify,
  type VerifyGateState,
  type VerifyTurnAction,
} from "../../agent-guards/index.js";

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
  toolResults: { toolCallId: string; status?: "ok" | "error" | "cancelled" }[],
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

  afterModelCall(ctx) {
    // Only evaluate at wrap-up: model ended the turn with text and no tool
    // calls. Mirrors premature-completion's wrap-up detection.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    const state = getMiddlewareState<VerifyGateState>(
      ctx.op.id,
      "verify-gate",
      createVerifyGateState,
    );
    const r = checkVerifyGate(state);
    if (r.nudge) return { kind: "nudge", message: r.nudge, reason: "verify-gate" };
    return { kind: "continue" };
  },
};
