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
import { decisionDenies, decisionRequiresPrompt, getApprovalManager, getRiskDecision } from "../approval-manager.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { readOpMessages } from "../canonical-loop/index.js";
import { parseStatusHeader } from "../tools/result-helpers.js";
import { resolveAgentPath } from "../workspace/paths.js";
import {
  GATED_DELETE_TOOL,
  describeUnnamedDeletesForHuman,
  gateAppliesToModel,
  recordUnnamedDeleteDecision,
  unnamedDeletes,
} from "./unnamed-delete-gate.js";

/** When the operation began: its first message row is the user's request. */
function requestStartedAt(operationId: string | undefined): number | undefined {
  if (!operationId) return undefined;
  const first = readOpMessages(operationId)[0];
  const at = first ? Date.parse(first.createdAt) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** A delete that runs without a card and is announced once it succeeded. */
export interface NoticedDelete { id: string; path: string }

export async function preauthorizeUnnamedDeletes(opts: {
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: string }>;
  priorMessages: readonly ChatCompletionMessageParam[] | undefined;
  modelId: string | undefined;
  callContext: string;
  sessionId?: string;
  operationId?: string;
  onEvent?: (event: ServerEvent) => void;
}): Promise<NoticedDelete[]> {
  // A notice needs someone watching and somewhere to show it; without both,
  // those files ask (interactive) or follow the profile (unattended), as before.
  const canNotice = opts.callContext === "local" && !!opts.onEvent && gateAppliesToModel(opts.modelId);
  const classified = unnamedDeletes(opts.toolCalls, opts.priorMessages, {
    sessionId: opts.sessionId,
    untrustedSession: opts.sessionId ? hasExternalIngestion(opts.sessionId) : true,
    requestStartedAt: canNotice ? requestStartedAt(opts.operationId) : undefined,
  });
  // A noticed delete records no decision: the autonomy profile still decides
  // it (Power runs it, Normal asks), exactly as for the agent's own files.
  const noticed = classified.filter((c) => c.notice).map(({ id, path }) => ({ id, path }));
  const gated = classified.filter((c) => !c.notice);
  if (gated.length === 0) return noticed;

  // The profile decides whether a delete is asked about (Peter, 2026-09-26:
  // "never see them in autonomous, just delete — power should stop as well").
  // A profile that denies destructive refuses each call in the approval phase.
  // One that allows it runs every delete_file — to the trash, announced with
  // Undo — and turns a shell delete of a file the user did not name back to
  // delete_file, the only delete that can be undone; no card either way.
  const rule = getRiskDecision("destructive", opts.sessionId);
  if (decisionDenies(rule)) return noticed;
  if (!decisionRequiresPrompt(rule)) {
    const trashed: NoticedDelete[] = [];
    for (const c of gated) {
      const shell = !opts.toolCalls.some((tc) => tc.id === c.id && tc.name === GATED_DELETE_TOOL);
      if (shell) recordUnnamedDeleteDecision(c.id, { approved: false, reason: "use-delete-file" });
      else if (c.folderFiles !== undefined && !canNotice) recordUnnamedDeleteDecision(c.id, { approved: false, reason: undefined });
      else trashed.push({ id: c.id, path: c.path });
    }
    return canNotice ? [...noticed, ...trashed] : noticed;
  }
  // Interactive dispatch only, like the irreversible floor: an unattended run
  // is governed by its autonomy profile, which already blocks an unanswerable ask.
  if (opts.callContext !== "local" || !gateAppliesToModel(opts.modelId)) {
    // No one can answer a card here. File deletes keep whatever the autonomy
    // profile allows, as before; a FOLDER delete is refused — it only became
    // possible on 2026-09-25, with a card, and must not become possible with
    // no one watching.
    for (const c of gated) {
      if (c.folderFiles !== undefined) recordUnnamedDeleteDecision(c.id, { approved: false, reason: undefined });
    }
    return noticed;
  }

  // No event sink means no way to show a card, so an answer can never arrive.
  // Refuse rather than let a sink-less dispatch confirm its own delete.
  if (!opts.onEvent) {
    for (const c of gated) recordUnnamedDeleteDecision(c.id, { approved: false, reason: undefined });
    return noticed;
  }

  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: GATED_DELETE_TOOL,
    toolCallId: gated[0].id,
    sessionId: opts.sessionId || "default",
    context: describeUnnamedDeletesForHuman(gated),
    args: { paths: gated.map((c) => c.path) },
    // Reached only when the profile asks; a remembered grant must not cover
    // the next, different set of files.
    alwaysAsk: true,
    opId: opts.operationId,
    emit: opts.onEvent,
  });
  for (const c of gated) {
    recordUnnamedDeleteDecision(c.id, outcome.approved ? { approved: true } : { approved: false, reason: outcome.reason });
  }
  return noticed;
}

/** After the batch: one notice, with Undo, for every noticed delete that went
 *  through. A delete that failed or was blocked announces nothing. The paths
 *  are absolute, the spelling the Undo route and restore_file resolve. */
export function announceNoticedDeletes(
  noticed: readonly NoticedDelete[],
  results: readonly ChatCompletionMessageParam[],
  onEvent: ((event: ServerEvent) => void) | undefined,
): void {
  if (!onEvent || noticed.length === 0) return;
  const deleted = noticed.filter((n) => {
    const row = results.find((r) => r.role === "tool" && r.tool_call_id === n.id);
    return !!row && typeof row.content === "string" && parseStatusHeader(row.content) === "ok";
  });
  if (deleted.length === 0) return;
  onEvent({
    type: "delete_notice",
    files: deleted.map((n) => resolveAgentPath(n.path)),
    toolCallIds: deleted.map((n) => n.id),
  });
}
