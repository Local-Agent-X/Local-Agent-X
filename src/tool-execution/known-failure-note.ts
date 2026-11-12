/**
 * The note that leads a failed result when this exact failure has a lesson the
 * user kept (cognition/cross-session-learning/known-failures.ts): what failed
 * before, in other chats, and what worked instead.
 *
 * This is the only place a lesson reaches the agent. It rides the result of
 * the call that failed, so a turn that never hits the failure never pays for
 * it, and it is one of the notes the audit phase already joins ahead of a
 * result (audit-tool-call.ts), not a new nudge.
 *
 * The lesson is a model's words about past tool output, so it is fenced as
 * recalled data, never stated as the harness's own instruction.
 *
 * It also keeps the one count that says whether a lesson helps: after a note
 * is shown in a run, the same work (tool and action) succeeding later in that
 * run is a recovery. A lesson is shown once per run for the same work; the
 * model already has it.
 */
import { noteLessonHelped, takeLessonFor } from "../cognition/cross-session-learning/known-failures.js";
import { asRecalledData } from "../context/system-prompt-builder.js";
import { statusOf } from "../tools/result-helpers.js";
import { actionOf } from "../tools/failure-signature.js";
import type { ToolCallContext } from "./context.js";
import type { ToolFailureFields } from "./tool-usage-telemetry.js";

/** Runs that were shown a lesson and have not yet repeated the work with
 *  success: run → (work → the lesson's signature). In memory: a run that
 *  outlives the process simply does not count as a recovery. */
const awaiting = new Map<string, Map<string, string>>();
const MAX_RUNS_AWAITING = 200;

function workOf(ctx: ToolCallContext): string {
  return `${ctx.tc.name}\u0000${actionOf(ctx.args) ?? ""}`;
}

function noteRecovery(run: string, work: string): void {
  const shown = awaiting.get(run);
  const signature = shown?.get(work);
  if (!shown || !signature) return;
  shown.delete(work);
  if (shown.size === 0) awaiting.delete(run);
  noteLessonHelped(signature);
}

function remember(run: string, work: string, signature: string): void {
  if (!awaiting.has(run) && awaiting.size >= MAX_RUNS_AWAITING) {
    const oldest = awaiting.keys().next().value;
    if (oldest !== undefined) awaiting.delete(oldest);
  }
  const shown = awaiting.get(run) ?? new Map<string, string>();
  shown.set(work, signature);
  awaiting.set(run, shown);
}

/**
 * The note for this call's result, or nothing. `failure` is what the usage
 * log recorded for the call (failure-record.ts); absent for a call that did
 * not fail. Never throws: a note is never worth a tool call.
 */
export function knownFailureNote(ctx: ToolCallContext, failure: ToolFailureFields | undefined): string | undefined {
  try {
    const run = ctx.operationId ?? ctx.sessionId;
    const work = workOf(ctx);
    if (!failure) {
      if (run && awaiting.size > 0 && ctx.result && statusOf(ctx.result) === "ok") noteRecovery(run, work);
      return undefined;
    }
    if (run && awaiting.get(run)?.get(work) === failure.signature) return undefined;
    const known = takeLessonFor(failure.signature);
    if (!known?.lesson) return undefined;
    if (run) remember(run, work, failure.signature);
    const chats = `${known.sessions} earlier chat${known.sessions === 1 ? "" : "s"}`;
    return `[Seen before] This call has failed this way in ${chats} on this computer. `
      + "The note below was kept from them: what failed and what worked instead. Weigh it against what you see now."
      + asRecalledData("known-failure", known.lesson);
  } catch {
    return undefined;
  }
}

/** Test-only: forget which runs were shown a lesson. */
export function _resetKnownFailureNotes(): void {
  awaiting.clear();
}
