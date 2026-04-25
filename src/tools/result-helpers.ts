import type { ToolDefinition, ToolResult } from "../types.js";
import { withPrompt } from "../tool-prompt-builder.js";

export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}

export const toolPrompts: Record<string, () => string> = {
  read: () => "Use read for files instead of bash cat/head/tail. Supports offset/limit for large files.",
  write: () => "Use write for new files instead of bash echo/heredoc. Read existing files before overwriting.",
  edit: () => "Use edit for targeted find-and-replace instead of bash sed/awk. Read the file first.",
  bash: () => "Only use bash for shell commands. Never use it for file read/write/search — use dedicated tools.",
  glob: () => "Use glob for finding files by name pattern. Faster than bash find/ls.",
  grep: () => "ALWAYS use grep for content search. Never bash grep/rg. Supports regex, type filtering, 3 output modes.",
  web_search: () => "Use web_search to find URLs, then web_fetch to read specific pages.",
  spreadsheet_read: () => "Use for Excel/CSV reading. Never write Python pandas scripts.",
  spreadsheet_write: () => "Pass data as JSON array of objects. Keys become headers.",
  document_create: () => "Use markdown formatting with \\n newlines. # for headings, - for bullets, **bold**.",
  presentation_from_outline: () => "Outline MUST use # for slide titles and - for bullets, separated by \\n.",
  pdf_create: () => "Use # for headings, \\n\\n for paragraph breaks.",
  sql_query: () => "Read-only by default. Run sql_schema first to see available tables.",
  ask_user: () => "Use when you need clarification. Don't guess — ask.",
  enter_plan_mode: () => "Enter plan mode to research before making changes. Only read tools available.",
  task_create: () => "Use for multi-step work. Tasks persist across messages.",
};

export function applyPrompts(tools: ToolDefinition[]): ToolDefinition[] {
  for (const t of tools) {
    const fn = toolPrompts[t.name];
    if (fn) withPrompt(t, fn);
  }
  return tools;
}
