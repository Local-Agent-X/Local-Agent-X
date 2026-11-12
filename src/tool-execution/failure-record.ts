/**
 * What the tool-usage log says about a call that failed: which failure it was
 * (tools/failure-signature.ts), its first line, and where the full record is.
 *
 * A failure here is the agent's: the call errored, timed out, or was refused
 * by a gate. Not counted:
 *  - a call the user declined or stopped (statuses `declined`, `cancelled`):
 *    a person said no, nothing is wrong with the call;
 *  - a call waiting on a person (layer `approval`): parked in the inbox or
 *    refused for want of someone to ask, the same call runs once they answer;
 *  - a result that was not produced by running the tool now (`resultReused`:
 *    a journal replay or a dedup-cache hit): the failure it repeats is already
 *    on record.
 */
import { isBlockLayer } from "../types.js";
import { statusOf } from "../tools/result-helpers.js";
import { failureReason, failureSignature } from "../tools/failure-signature.js";
import type { ToolCallContext } from "./context.js";
import { scrubMetadata } from "./tool-message-carry.js";
import type { ToolFailureFields } from "./tool-usage-telemetry.js";

const FAILURE_STATUSES: ReadonlySet<string> = new Set(["error", "blocked", "timeout"]);

/** The `action` of a one-tool-many-actions family, as the usage log records it. */
export function actionOf(args: Record<string, unknown>): string | undefined {
  return typeof args.action === "string" ? args.action : undefined;
}

export function failureRecordOf(ctx: ToolCallContext): ToolFailureFields | undefined {
  const result = ctx.result;
  if (!result || ctx.resultReused) return undefined;
  const status = statusOf(result);
  if (!FAILURE_STATUSES.has(status)) return undefined;
  const named = result.metadata?.layer;
  const layer = isBlockLayer(named) ? named : undefined;
  if (layer === "approval") return undefined;
  // The signature is taken from the redacted line, so a secret in an error
  // message never decides which failure this is.
  const reason = scrubMetadata(failureReason(result.content));
  return {
    signature: failureSignature({ tool: ctx.tc.name, action: actionOf(ctx.args), status, layer, reason }),
    reason,
    ...(layer ? { layer } : {}),
    ...(ctx.operationId ? { opId: ctx.operationId } : {}),
    toolCallId: ctx.tc.id,
  };
}
