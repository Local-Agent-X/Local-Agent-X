import type { ServerEvent, ToolDefinition, ToolResult } from '../types.js';
import { isEnforcedPlanMode, setEnforcedPlanMode } from '../canonical-loop/public/plan-ledger.js';
import { getApprovalManager } from '../approval-manager.js';

// Session-scoped plan mode — each session tracks its own state. This set is
// the SOFT mode the model enters/exits itself; the ENFORCED mode (user's Plan
// toggle, only the user can lift it) lives in the instruction ledger and is
// OR'd in below so both flavors share the read-only gate + messaging.
const planModeSessions = new Set<string>();

export function isPlanMode(sessionId?: string): boolean {
  if (!sessionId) return planModeSessions.size > 0; // legacy fallback
  return planModeSessions.has(sessionId) || isEnforcedPlanMode(sessionId);
}

/** User turned enforced plan mode off — drop any model-set soft flag too, so
 *  the approval actually restores full access in one step. */
export function clearSoftPlanMode(sessionId: string): void {
  planModeSessions.delete(sessionId);
}

// What plan mode permits is what changes nothing, read off each tool's policy
// row (tool-registry isReadOnlyCall): a tool's risk tier and the paths, kernel
// action and destination of the call. There is no list of read-only names to
// keep: email_delete is a write because its row says so, ask_user a read
// because its row's risk is safe (it delivers a question and ends the turn —
// plan mode is exactly when a clarifying question is most useful).
export { isReadOnlyCall } from '../tool-registry.js';

const enterPlanMode: ToolDefinition = {
  name: 'enter_plan_mode',
  description: 'Enter plan mode to research and analyze before making changes. Only read-only tools are available in plan mode.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    // Session ID is injected via metadata by the executor
    const sid = (_args._sessionId as string) || 'default';
    planModeSessions.add(sid);
    return { content: 'Plan mode activated. You can only use read-only tools (read, grep, glob, web_search, web_fetch, sql_query, and the read actions of spreadsheet/document/pdf). Use exit_plan_mode when ready to make changes.' };
  },
};

const exitPlanMode: ToolDefinition = {
  name: 'exit_plan_mode',
  description: 'Exit plan mode and restore full tool access. Optionally summarize what you learned. If ENFORCED plan mode is on (the user\'s Plan toggle), this instead shows the user an approval card carrying your `summary` — the plan they are approving — and only their approval ends plan mode.',
  parameters: { type: 'object', properties: { summary: { type: 'string', description: 'What you learned or planned. Under enforced plan mode this is REQUIRED: it is the plan the user is asked to approve.' } }, required: [] },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sid = (args._sessionId as string) || 'default';
    if (isEnforcedPlanMode(sid)) return exitEnforcedPlanMode(sid, args);
    planModeSessions.delete(sid);
    const summary = typeof args.summary === 'string' ? `\n\nSummary: ${args.summary}` : '';
    return { content: `Plan mode deactivated. Full tool access restored.${summary}` };
  },
};

/**
 * Enforced plan mode exit — the approval is the USER's, not the model's. The
 * model's `summary` becomes the approval card's context so the user approves a
 * concrete plan, not a bare mode flip. Approval resolves through the same
 * ApprovalManager card the other consent prompts use (WS approval_response →
 * resolveApproval); decline/timeout keeps the mode on, and the manager's
 * decline-suppression auto-declines an immediate identical re-issue.
 */
/** Sessions with a plan-approval card currently awaiting the user. One card
 *  per session, period — a model retry (rephrased summary, impatient re-call)
 *  must NOT stack a second card while the first is undecided. */
const pendingPlanApproval = new Set<string>();

async function exitEnforcedPlanMode(sid: string, args: Record<string, unknown>): Promise<ToolResult> {
  const emit = args._onEvent as ((event: ServerEvent) => void) | undefined;
  if (!emit) {
    // No interactive channel (headless/cron dispatch) — nobody can click a card.
    return { content: 'Enforced plan mode is on for this session and there is no interactive user to approve ending it. Present your plan in your reply; the user lifts plan mode with the Plan toggle.' };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return { content: 'Enforced plan mode is on. To request approval, call exit_plan_mode again WITH a `summary` of your plan — that summary is exactly what the user is shown to approve. Keep it concrete: what you will change and where.' };
  }
  if (pendingPlanApproval.has(sid)) {
    return { content: 'A plan-approval card is ALREADY awaiting the user\'s decision for this session. Do not call exit_plan_mode again — end your turn and wait for the user to approve, deny, or reply.' };
  }
  pendingPlanApproval.add(sid);
  const approved = await getApprovalManager().requestApproval({
    toolName: 'exit_plan_mode',
    toolCallId: (args._toolCallId as string) || `plan-exit-${sid}`,
    sessionId: sid,
    context: `Approve this plan to end plan mode and allow changes:\n\n${summary}`,
    args: { summary },
    alwaysAsk: true, // ending a standing user mandate must never auto-approve from cache
    emit,
  }).finally(() => pendingPlanApproval.delete(sid));
  if (!approved) {
    return { content: 'The user did NOT approve the plan (declined or timed out) — plan mode stays on. Do not re-issue this call; revise the plan from their feedback or ask what they want changed.' };
  }
  setEnforcedPlanMode(sid, false);
  planModeSessions.delete(sid);
  emit({ type: 'plan_mode_changed', enforced: false });
  return { content: 'Plan approved by the user — plan mode is off and full tool access is restored. Proceed with the approved plan; stay within its scope.' };
}

export const planTools: ToolDefinition[] = [enterPlanMode, exitPlanMode];
