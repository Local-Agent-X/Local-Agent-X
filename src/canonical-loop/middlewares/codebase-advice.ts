/**
 * Codebase-advice grounding — if the user asks for repo/harness implementation
 * direction, a model must inspect current code before recommending the next
 * move. Docs, memory, and prior assistant summaries are leads, not proof.
 */
import {
  CODEBASE_ADVICE_GROUNDING_REASON,
  checkUngroundedCodebaseAdvice,
} from "../../agent-guards/index.js";
import { getMiddlewareState } from "./state.js";
import type { CanonicalMiddleware } from "./types.js";

interface FiredFlag { fired: boolean }

export const codebaseAdviceMiddleware: CanonicalMiddleware = {
  name: "codebase-advice",

  afterModelCall(ctx) {
    // "Did the USER ask for codebase direction?" — so a harness-composed task
    // cannot answer it. A dream brief or eval prompt asking what to do next in
    // the repo is the harness talking to itself, not a request to ground. Gate
    // before checkUngroundedCodebaseAdvice so its matcher never reads machine
    // prose as the user's ask.
    //
    // Gate on the provenance STAMP ALONE — deliberately NOT isHarnessAuthoredTask,
    // which also treats op.type === "app_build" as harness-authored. That extra
    // branch is right for the instruction ledger but wrong here, for two reasons:
    //   - it buys nothing. build-app.ts sets task to `Build app "<name>"`, and
    //     0 of 77 persisted app_build ops match this middleware's predicate.
    //   - it opens a self-muzzle. op.type is MODEL-supplied and unvalidated
    //     (ops/tools/shared.ts:172 `String(args.type || "freeform")`), and the
    //     op_submit schema invites the model to pick a type while instructing it
    //     to relay the user's words verbatim — so trusting op.type would let a
    //     model silently switch this guard off on a real user request.
    // taskProvenance is stamped by the harness only, never by model output.
    if (ctx.op.taskProvenance === "harness") return { kind: "continue" };
    if (ctx.toolCalls.length > 0) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "codebase-advice",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };

    const nudge = checkUngroundedCodebaseAdvice(
      ctx.currentUserMessage,
      ctx.assistantContent,
      ctx.toolsCalledThisOp,
    );
    if (!nudge) return { kind: "continue" };

    flag.fired = true;
    return { kind: "nudge", message: nudge, reason: CODEBASE_ADVICE_GROUNDING_REASON };
  },
};
