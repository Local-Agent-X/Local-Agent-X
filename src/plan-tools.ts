import type { ToolDefinition, ToolResult } from './types.js';

// Session-scoped plan mode — each session tracks its own state
const planModeSessions = new Set<string>();

export function isPlanMode(sessionId?: string): boolean {
  if (!sessionId) return planModeSessions.size > 0; // legacy fallback
  return planModeSessions.has(sessionId);
}

export const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'web_search', 'web_fetch', 'view_image',
  'sql_query', 'sql_schema', 'sql_explain', 'spreadsheet_read', 'spreadsheet_query',
  'document_read', 'pdf_read', 'pdf_extract_tables', 'clipboard_read',
  'calendar_list_events', 'calendar_check_availability', 'email_read', 'email_search',
  'enter_plan_mode', 'exit_plan_mode', 'task_list', 'task_get', 'tool_search',
]);

const enterPlanMode: ToolDefinition = {
  name: 'enter_plan_mode',
  description: 'Enter plan mode to research and analyze before making changes. Only read-only tools are available in plan mode.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    // Session ID is injected via metadata by the executor
    const sid = (_args._sessionId as string) || 'default';
    planModeSessions.add(sid);
    return { content: 'Plan mode activated. You can only use read-only tools (read, grep, glob, web_search, web_fetch, sql_query, spreadsheet_read, document_read, pdf_read). Use exit_plan_mode when ready to make changes.' };
  },
};

const exitPlanMode: ToolDefinition = {
  name: 'exit_plan_mode',
  description: 'Exit plan mode and restore full tool access. Optionally summarize what you learned.',
  parameters: { type: 'object', properties: { summary: { type: 'string', description: 'What you learned or planned' } }, required: [] },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sid = (args._sessionId as string) || 'default';
    planModeSessions.delete(sid);
    const summary = typeof args.summary === 'string' ? `\n\nSummary: ${args.summary}` : '';
    return { content: `Plan mode deactivated. Full tool access restored.${summary}` };
  },
};

export const planTools: ToolDefinition[] = [enterPlanMode, exitPlanMode];
