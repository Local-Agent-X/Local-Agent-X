/**
 * Refute-completion guard — a WORKER op ends with a final "done" claim (visible
 * text, zero tool calls this turn) AFTER having committed real work. Fire an
 * independent skeptic panel at that claim, judged against the task and the
 * actions actually taken, and on a strict-majority refutation nudge ONE more
 * turn WITH the skeptics' reasons so the worker fixes the gap or says concretely
 * why it's done.
 *
 * This is the harness-driven counterpart to the model-driven "call tool_search"
 * nudge: the model that falsely claims done won't refute itself, so the harness
 * does it. Complements premature-completion (which catches the NO-work case —
 * this gates on committingToolsThisOp > 0, the opposite signal) and the
 * deterministic verify-gate/cleanup-verify.
 *
 * Posture: worker-only, fire-once, FAIL-OPEN. Only an affirmative majority
 * refutation nudges; inconclusive/holds/any error proceeds. The skeptics see
 * the task, the claim, and a SUMMARY of committing actions — not the diffs
 * (afterModelCall has no tool-result content), so this catches done-claims that
 * are implausible or inconsistent with the task, not deep correctness bugs.
 * Cost is bounded: at most one panel per worker op, and — because it sits after
 * the cheaper deterministic gates in the stack — only when none of them already
 * nudged. Disable with LAX_REFUTE_COMPLETION=0.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { refuteClaim } from "../../classifiers/refute-claim.js";

interface FiredFlag { fired: boolean }

const TASK_MAX = 400;
const CLAIM_MAX = 1200;

export const refuteCompletionMiddleware: CanonicalMiddleware = {
  name: "refute-completion",

  when: isWorkerOp,

  async afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };            // still working, not a terminal claim
    const claim = ctx.assistantContent.trim();
    if (claim.length === 0) return { kind: "continue" };                  // empty → post-turn-detector's case
    if (ctx.committingToolsThisOp.size === 0) return { kind: "continue" }; // no work → premature-completion's case

    // Fire once per op — the panel is the expensive path; a real worker gets
    // one refutation, fixes or re-affirms, and completes.
    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "refute-completion",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    const task = ctx.userMessage.trim().slice(0, TASK_MAX);
    const actions = [...ctx.committingToolsThisOp].join(", ") || "(none recorded)";
    const context =
      `The TASK the worker was given:\n${task}\n\n` +
      `Committing actions it actually took this op: ${actions}.\n` +
      `Distinct tools used across the op: ${ctx.toolsCalledThisOp.size}.`;

    let result: Awaited<ReturnType<typeof refuteClaim>>;
    try {
      result = await refuteClaim({
        claim: claim.slice(0, CLAIM_MAX),
        context,
        category: "refute-completion",
        envDisableVar: "LAX_REFUTE_COMPLETION",
      });
    } catch {
      return { kind: "continue" }; // fail-open on any error
    }

    if (!result.refuted) return { kind: "continue" };

    const why = result.reasons.length
      ? " Specifically: " + result.reasons.slice(0, 3).map((r) => `(${r})`).join(" ")
      : "";
    const message =
      `Before finishing: an independent review (${result.summary}) is not convinced this task is actually complete.${why}\n\n` +
      `Re-check the task against what you actually did. If a skeptic is right, fix it now with the tools. ` +
      `If the work genuinely holds up, state briefly why it's complete and what evidence supports that — don't just repeat "done".`;
    return { kind: "nudge", message, reason: "refute-completion" };
  },
};
