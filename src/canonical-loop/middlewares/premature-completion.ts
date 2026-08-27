/**
 * Premature-completion guard — a worker op (NOT chat) ends with a
 * final-sounding paragraph, zero tool calls, and nothing committed. The
 * turn-loop reads noTools+text as "done" (turn-loop.ts ~307-316) and the op
 * completes having taken no action toward the task. Force one more turn.
 *
 * Interactive ops (chat + voice) legitimately answer tool-lessly, so `when`
 * exempts them via isWorkerOp. Fires at most once per op — the fire-once cap is
 * the safety valve: a real research/analysis worker that answers with text gets
 * ONE nudge, re-affirms, and completes.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { capabilityForbiddenForOp } from "../instruction-ledger/index.js";

interface FiredFlag { fired: boolean }

const TASK_MAX = 280;

export const prematureCompletionMiddleware: CanonicalMiddleware = {
  name: "premature-completion",

  when: isWorkerOp,

  afterModelCall(ctx) {
    // This guard purely pushes committing ACTION — never against an explicit
    // user prohibition ("read-only", "don't change anything"). Fail-open: an
    // op with no ledger entry is never suppressed.
    if (capabilityForbiddenForOp(ctx.op, "workspace-write")) return { kind: "continue" };
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };
    // The question THIS gate asks: "did the worker take committing action
    // toward the USER'S task?" — so the op's own task ledger is not an answer.
    // An op whose only successful committing calls were task_create/task_update
    // wrote a to-do list and nothing else, which is precisely the no-action case
    // this gate exists to push. NOT the same question as mid-turn-stale's
    // ctx.committingToolsThisOp check ("is there a side effect on record I'd
    // be aborting on top of?" — where planning counts). Do not unify
    // the two call sites; that re-merge is how this bug class regenerates.
    // host.ts precomputes this from the op_turns walk it already does — never
    // re-read op_turns here.
    if (ctx.substantiveCommittingToolsThisOp.size > 0) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "premature-completion",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    const task = ctx.userMessage.trim().slice(0, TASK_MAX);
    const message =
      `Task: ${task}\n\n` +
      "You're ending this turn without having taken any committing action " +
      "toward the task — nothing has been written, saved, or changed. If the " +
      "task needs work, do it now using the available tools. If you genuinely " +
      "cannot proceed, state the specific blocker. Do not stop with only a " +
      "summary when the work isn't done.";

    return { kind: "nudge", message, reason: "premature-completion" };
  },
};
