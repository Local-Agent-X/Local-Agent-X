/**
 * How long a tool call has sat waiting for a human, per toolCallId.
 *
 * The ask happens INSIDE the tool's own execution, which the runner bounds with
 * a per-tool timeout (tool-execution/tool-timeout.ts). Those two budgets were
 * unrelated: a browser tool bounded at 30s could raise a 5-minute card, so
 * every sensitive-page action died half a minute in, no matter how fast the
 * user clicked — then the model retried and raised a fresh card, stacking
 * prompts the user could never satisfy (live 2026-09-16, Google Cloud console:
 * twelve minutes of 30s timeouts recorded in the side-effect journal).
 *
 * A tool's timeout is meant to bound the TOOL's work, not the person's reading
 * time, so the runner excludes whatever accrues here.
 *
 * Its own module because approval-manager.ts sits at the 400-LOC source-hygiene
 * ceiling, and this is a self-contained ledger — the same split that already
 * produced approval-decision.ts and approval-preview.ts.
 */

const approvalWaitMs = new Map<string, number>();

/** Bank a settled wait against the call that raised it. Accumulated, not
 *  overwritten: one call can ask more than once. */
export function recordApprovalWait(toolCallId: string, waitedMs: number): void {
  if (waitedMs <= 0) return;
  approvalWaitMs.set(toolCallId, approvalWaitMsFor(toolCallId) + waitedMs);
}

export function approvalWaitMsFor(toolCallId: string): number {
  return approvalWaitMs.get(toolCallId) ?? 0;
}

export function clearApprovalWait(toolCallId: string): void {
  approvalWaitMs.delete(toolCallId);
}
