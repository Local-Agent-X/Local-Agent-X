/**
 * The batch pre-pass for the un-named delete floor: ONE card per turn.
 *
 * Approvals are requested per tool call, and a model that wipes a folder emits
 * its deletes in one assistant turn — five calls, five cards. So before the
 * batch dispatches, every delete whose target the user did not name is
 * collected into a single confirmation, and each call later picks up its
 * answer in requireApprovalPhase. The rule itself lives in
 * unnamed-delete-gate.ts; this file only owns the asking.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ServerEvent } from "../types.js";
import { getApprovalManager } from "../approval-manager.js";
import {
  GATED_DELETE_TOOL,
  describeUnnamedDeletesForHuman,
  gateAppliesToModel,
  recordUnnamedDeleteDecision,
  unnamedDeletes,
} from "./unnamed-delete-gate.js";

export async function preauthorizeUnnamedDeletes(opts: {
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: string }>;
  priorMessages: readonly ChatCompletionMessageParam[] | undefined;
  modelId: string | undefined;
  callContext: string;
  sessionId?: string;
  operationId?: string;
  onEvent?: (event: ServerEvent) => void;
}): Promise<void> {
  // Interactive dispatch only, like the irreversible floor: an unattended run
  // is governed by its autonomy profile, which already blocks an unanswerable ask.
  if (opts.callContext !== "local" || !gateAppliesToModel(opts.modelId)) return;
  const gated = unnamedDeletes(opts.toolCalls, opts.priorMessages);
  if (gated.length === 0) return;

  // No event sink means no way to show a card, so an answer can never arrive.
  // Refuse rather than let a sink-less dispatch confirm its own delete.
  if (!opts.onEvent) {
    for (const c of gated) recordUnnamedDeleteDecision(c.id, { approved: false, reason: undefined });
    return;
  }

  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: GATED_DELETE_TOOL,
    toolCallId: gated[0].id,
    sessionId: opts.sessionId || "default",
    context: describeUnnamedDeletesForHuman(gated),
    args: { paths: gated.map((c) => c.path) },
    alwaysAsk: true,
    opId: opts.operationId,
    emit: opts.onEvent,
  });
  for (const c of gated) {
    recordUnnamedDeleteDecision(c.id, outcome.approved ? { approved: true } : { approved: false, reason: outcome.reason });
  }
}
