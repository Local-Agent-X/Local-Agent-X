/**
 * A build's chunk worker holds every tool its lead's chat could
 * (ops/types.ts routing.buildWorker). The one thing that must not come with
 * them is the lead's autonomy to act as the owner toward the outside: a send
 * or a publish from a build worker asks a person under every profile, which
 * for a run nobody watches means it waits in the inbox.
 */
import type { ToolCallContext } from "./context.js";
import { readOp } from "../ops/op-store.js";
import { publishOperations } from "../publish-operation.js";
import { sendsOutward } from "./send-destinations.js";
import { addApprovalReason } from "./approval-card-text.js";

/** A call made by an auto-build chunk worker that builds. */
export function isBuildWorkerCall(ctx: Pick<ToolCallContext, "callContext" | "operationId">): boolean {
  if (ctx.callContext !== "delegated" || !ctx.operationId) return false;
  return readOp(ctx.operationId)?.contextPack?.routing?.buildWorker === true;
}

export function buildWorkerSendGate(ctx: Pick<ToolCallContext, "callContext" | "operationId" | "tc" | "args" | "policyApprovalReason">): void {
  if (!isBuildWorkerCall(ctx)) return;
  if (publishOperations(ctx.tc.name, ctx.args).length === 0 && !sendsOutward(ctx.tc.name, ctx.args)) return;
  addApprovalReason(ctx, "a build worker's send or publish waits for the owner, whatever the chat's autonomy");
}
