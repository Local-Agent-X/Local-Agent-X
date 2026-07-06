import type { ToolDefinition, ToolResult } from '../types.js';
import { isEnforcedPlanMode } from '../canonical-loop/instruction-ledger/index.js';

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

export const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'web_search', 'web_fetch', 'view_image',
  'sql_query', 'sql_schema', 'sql_explain', 'clipboard_read',
  'calendar_list_events', 'calendar_check_availability', 'email_read', 'email_search',
  'enter_plan_mode', 'exit_plan_mode', 'task_list', 'task_get', 'tool_search',
]);

/** Read-only ACTIONS of the collapsed one-tool-many-actions office families —
 *  the name alone can't prove read-only, so plan mode checks (name, action). */
const READ_ONLY_TOOL_ACTIONS: Record<string, ReadonlySet<string>> = {
  spreadsheet: new Set(['read', 'query']),
  document: new Set(['read']),
  pdf: new Set(['read', 'extract_tables']),
};

export function isReadOnlyCall(name: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true;
  const actions = READ_ONLY_TOOL_ACTIONS[name];
  return actions !== undefined && actions.has(String(args.action ?? ''));
}

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
  description: 'Exit plan mode and restore full tool access. Optionally summarize what you learned.',
  parameters: { type: 'object', properties: { summary: { type: 'string', description: 'What you learned or planned' } }, required: [] },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sid = (args._sessionId as string) || 'default';
    if (isEnforcedPlanMode(sid)) {
      // The user's Plan toggle is the only thing that lifts enforced mode —
      // an agent-initiated exit would defeat the point of the mandate.
      return { content: 'Enforced plan mode is on for this session — only the user can turn it off (the Plan toggle next to the composer). Present your plan and ask the user to approve it; do not retry this call.' };
    }
    planModeSessions.delete(sid);
    const summary = typeof args.summary === 'string' ? `\n\nSummary: ${args.summary}` : '';
    return { content: `Plan mode deactivated. Full tool access restored.${summary}` };
  },
};

export const planTools: ToolDefinition[] = [enterPlanMode, exitPlanMode];
