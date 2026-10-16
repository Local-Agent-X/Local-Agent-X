// The one place a refused unattended tool call becomes a user inbox item.
//
// An unattended run (cron, delegated, api) has no one to show an approval
// card to, so the gates refuse the call and the run carries on without it.
// Before this, the refusal reached only the model's tool result: the user
// never learned that their job skipped something it needed them for. Every
// gate that refuses for want of a person calls this, so phase 2 (park the
// call as an approval and run it on the user's yes) changes one function.

import type { ToolCallContext } from "./context.js";
import { isHeadlessSession } from "../chat-ws/broadcast.js";
import { readOp } from "../ops/op-store.js";
import { OP_TYPE } from "../ops/op-types.js";
import { inboxRefusedAction, runLabel } from "../inbox/producers.js";

function jobLabel(ctx: ToolCallContext): string {
  let op: ReturnType<typeof readOp> = null;
  try { op = ctx.operationId ? readOp(ctx.operationId) : null; } catch { /* unreadable op: name the run by its context alone */ }
  const scheduled = op?.type === OP_TYPE.scheduledMission || ctx.callContext === "cron";
  return runLabel(scheduled ? "Scheduled job" : "Background task", op?.task ?? "");
}

export function reportUnattendedRefusal(ctx: ToolCallContext, reason: string): void {
  if (ctx.callContext === "local") return;
  // Harness runs (skill review, dreaming, evals) are not the user's jobs.
  if (ctx.sessionId && isHeadlessSession(ctx.sessionId)) return;
  const args = Object.fromEntries(Object.entries(ctx.args).filter(([name]) => !name.startsWith("_")));
  inboxRefusedAction({
    toolName: ctx.tc.name,
    args,
    callContext: ctx.callContext,
    reason,
    jobLabel: jobLabel(ctx),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.operationId ? { opId: ctx.operationId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  });
}
