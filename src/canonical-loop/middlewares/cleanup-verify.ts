/**
 * Cleanup-verify middleware — the task is a removal/cleanup sweep and the model
 * is wrapping up by reporting it DONE, but no grep this op came back empty to
 * prove the target is actually gone. Accumulate clean-search evidence after each
 * dispatch; at wrap-up (model ends tool-lessly with text, the same signal
 * premature-completion keys on) nudge once to re-search, and set the verdict the
 * terminal-outcome label reads so an unconfirmed cleanup records `partial`,
 * never a rounded-up `clean`.
 *
 * The sibling of verify-gate (build verification) for SEARCH verification — a
 * removal is proven by an empty search, not a passing build. All lanes: a
 * "finish cleaning up X" instruction is most often interactive chat, so unlike
 * verify-gate this is NOT worker-only.
 *
 * Detection logic lives in src/agent-guards/cleanup-verify.ts; this is the thin
 * canonical wiring.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import {
  looksLikeCleanupSweep,
  noteCleanupEvidence,
  checkCleanupVerify,
  claimsCleanupDone,
  createCleanupVerifyState,
  type CleanupVerifyState,
} from "../../agent-guards/index.js";

/**
 * The latest verdict this gate computed for the op, persisted so the
 * terminal-outcome label (decide-outcome.ts) can read it. A cleanup op that
 * ends without a confirming search records `partial`, not a rounded-up `clean`.
 * Defaults false — ops the gate never evaluated keep their prior labeling.
 */
export function opCleanupUnverified(opId: string): boolean {
  return getMiddlewareState<CleanupVerifyState>(
    opId, "cleanup-verify", createCleanupVerifyState,
  ).unverified;
}

export const cleanupVerifyMiddleware: CanonicalMiddleware = {
  name: "cleanup-verify",

  afterToolExecution(ctx) {
    if (!looksLikeCleanupSweep(ctx.userMessage)) return { kind: "continue" };
    const state = getMiddlewareState<CleanupVerifyState>(
      ctx.op.id, "cleanup-verify", createCleanupVerifyState,
    );
    noteCleanupEvidence(ctx.toolResults, state);
    return { kind: "continue" };
  },

  afterModelCall(ctx) {
    // Only at wrap-up: model ended the turn with text and no tool calls.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };
    if (!looksLikeCleanupSweep(ctx.userMessage)) return { kind: "continue" };

    const state = getMiddlewareState<CleanupVerifyState>(
      ctx.op.id, "cleanup-verify", createCleanupVerifyState,
    );
    const r = checkCleanupVerify(state);
    if (r.nudge) {
      // When the wrap-up positively claims the cleanup is finished but no search
      // confirmed it, that bubble is a confirmed-false claim the next turn
      // supersedes — flag it for retraction (decide-outcome strips it) so the
      // user never reads a "Cleanup complete" that the loop is about to walk
      // back. An honest "not done / still remain" wrap-up keeps the plain reason
      // and stands.
      const reason = claimsCleanupDone(ctx.assistantContent)
        ? "cleanup-verify-false-done"
        : "cleanup-verify";
      return { kind: "nudge", message: r.nudge, reason };
    }
    return { kind: "continue" };
  },
};
