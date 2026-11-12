/**
 * What the tool-usage log says about a call that failed: which failure it was
 * (tools/failure-signature.ts), its first line, and where the full record is.
 *
 * What counts is countsAsFailure's rule. One more case is skipped here: a
 * result that was not produced by running the tool now (`resultReused`: a
 * journal replay or a dedup-cache hit). The failure it repeats is already on
 * record.
 */
import { isBlockLayer } from "../types.js";
import { statusOf } from "../tools/result-helpers.js";
import { actionOf, countsAsFailure, failureReason, failureSignature } from "../tools/failure-signature.js";
import type { ToolCallContext } from "./context.js";
import { scrubMetadata } from "./tool-message-carry.js";
import type { ToolFailureFields } from "./tool-usage-telemetry.js";

export function failureRecordOf(ctx: ToolCallContext): ToolFailureFields | undefined {
  const result = ctx.result;
  if (!result || ctx.resultReused) return undefined;
  const status = statusOf(result);
  const named = result.metadata?.layer;
  const layer = isBlockLayer(named) ? named : undefined;
  if (!countsAsFailure(status, layer)) return undefined;
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
