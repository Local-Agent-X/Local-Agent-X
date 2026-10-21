// The one place a call an unattended run could not make without a person is
// parked for the user's yes, and the one place a gate learns the user already
// gave it.
//
// An unattended run (cron, delegated, api) has no one to show an approval
// card to. It does not pause: the gate parks the call in the user's inbox (an
// "approval" item, src/inbox/approvals.ts), the model reads that the call is
// waiting there, and the run finishes what it can without it. On Approve the
// inbox runs that exact call through this pipeline again (approved-call.ts)
// under a one-shot grant: every gate re-runs, and each gate that would park,
// refuse or prompt for want of a person takes the grant instead
// (takeUserGrant). The gates that park: the approval phase's unattended
// branch (require-approval.ts), the secret_env card (secret-env-approval.ts),
// the unattended shell gate (run-sandboxed.ts), and every gate inside a tool
// that marks its refusal `needsUser` (tools/result-helpers.ts): the browser's
// sensitive-page, download-release and CAPTCHA gates (browser-tools/gates.ts)
// and the first use of a vault secret at a new destination
// (secret-destination-gate.ts: the credential fill, http_request,
// connector_create, email_setup). Those
// cannot reach the inbox themselves, so run-sandboxed.ts parks their result
// (parkNeedsUser) and hands them the user's grant as `_userGrant`.
//
// The parked result stays status "blocked": statusOf, the renderers, the
// phone and the loop guards read that status. What marks it parked is the
// structured `metadata.deferredTo` (the inbox item id), which the block record
// carries to the loop (block-record.ts) — never the refusal's wording.

import type { ToolCallContext } from "./context.js";
import type { ToolResult } from "../types.js";
import { getApprovalManager } from "../approval-manager.js";
import { isHeadlessSession } from "../chat-ws/broadcast.js";
import { readOp } from "../ops/op-store.js";
import { OP_TYPE } from "../ops/op-types.js";
import { runLabel } from "../inbox/producers.js";
import { inboxApprovalRequest } from "../inbox/approvals.js";
import type { DeferredGrant } from "../inbox/types.js";
import { cronJobIdOf } from "../cron/cron-session.js";
import { takeNeedsUser } from "../tools/result-helpers.js";

const PARKED_TEXT =
  "This call is now waiting in the user's inbox for their yes; if they approve it, it runs then, on its own. " +
  "Do not try it again or another way: continue the rest of the task without it, and say in your report that it is waiting for the user's approval.";
const PARKED_RECOVERY =
  "The call is parked in the user's inbox. Continue the rest of the task without it and mention it in your report.";

function jobLabel(ctx: ToolCallContext): string {
  let op: ReturnType<typeof readOp> = null;
  try { op = ctx.operationId ? readOp(ctx.operationId) : null; } catch { /* unreadable op: name the run by its context alone */ }
  const scheduled = op?.type === OP_TYPE.scheduledMission || ctx.callContext === "cron";
  return runLabel(scheduled ? "Scheduled job" : "Background task", op?.task ?? "");
}

/** Park this call in the user's inbox. Returns the item id, or null when
 *  nothing was parked: an attended run (it shows a card instead), a harness
 *  run that is not the user's job, or an inbox that could not record it. */
export function deferUnattendedCall(ctx: ToolCallContext, reason: string, grant?: DeferredGrant): string | null {
  if (ctx.callContext === "local") return null;
  // Harness runs (skill review, dreaming, evals) are not the user's jobs.
  if (ctx.sessionId && isHeadlessSession(ctx.sessionId)) return null;
  const args = Object.fromEntries(Object.entries(ctx.args).filter(([name]) => !name.startsWith("_")));
  const cronJobId = cronJobIdOf(ctx.sessionId);
  const item = inboxApprovalRequest({
    toolName: ctx.tc.name,
    args,
    callContext: ctx.callContext,
    reason,
    jobLabel: jobLabel(ctx),
    ...(ctx.callerRole ? { callerRole: ctx.callerRole } : {}),
    ...(cronJobId ? { cronJobId } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.operationId ? { opId: ctx.operationId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(grant ? { grant } : {}),
  });
  return item?.id ?? null;
}

/**
 * The model's result for a call a gate could not run unattended: parked in
 * the inbox when it can be (the gate's own `reason`, then where the call
 * went), else the gate's `refusal` unchanged. `modelNote` is gate detail for
 * the model only (a publish review), kept out of the user's inbox; `grant` is
 * what the user's yes keeps beyond the call, for the item's wording.
 */
export function parkOrRefuse(ctx: ToolCallContext, reason: string, refusal: ToolResult, modelNote = "", grant?: DeferredGrant): ToolResult {
  const itemId = deferUnattendedCall(ctx, reason, grant);
  if (!itemId) return refusal;
  // The gate's user hint described a refusal ("relax the rule ..."); nothing
  // is refused here, the call is waiting, and the text says so.
  const { userHint: _refusalHint, ...gateMetadata } = refusal.metadata ?? {};
  return {
    content: `${reason}\n\n${PARKED_TEXT}${modelNote ? `\n\n${modelNote}` : ""}`,
    isError: true,
    status: "blocked",
    metadata: { ...gateMetadata, layer: "approval", deferredTo: itemId, recovery: PARKED_RECOVERY },
  };
}

/**
 * A tool's own refusal for want of a person (`metadata.needsUser`), parked the
 * way a pipeline gate's is; any other result, or an attended run, unchanged
 * apart from the mark, which the model never needs.
 */
export function parkNeedsUser(ctx: ToolCallContext, result: ToolResult): ToolResult {
  const marked = takeNeedsUser(result);
  if (!marked) return result;
  return parkOrRefuse(ctx, marked.reason, marked.result, "", marked.grant);
}

/**
 * The user's one-shot yes to this exact call, if the inbox gave one for this
 * dispatch (approval-call-grants.ts). The first gate that asks consumes it and
 * marks the call approved by the user (the threat engine reads that); later
 * gates in the same dispatch see the same grant. Returns the grant id.
 */
export function takeUserGrant(ctx: ToolCallContext): string | null {
  if (ctx.userGrantId) return ctx.userGrantId;
  const grantId = getApprovalManager().callGrants.take(ctx.sessionId || "default", ctx.tc.name, ctx.args);
  if (!grantId) return null;
  ctx.userGrantId = grantId;
  ctx.approvedByUser = true;
  return grantId;
}
