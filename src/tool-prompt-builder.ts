/**
 * Tool Prompt Builder — generates system prompt sections from tool definitions.
 * Each tool can contribute natural-language usage instructions via a prompt() function.
 * These get injected into the system prompt to teach the LLM best practices.
 */
import type { ToolDefinition } from "./types.js";

interface ToolWithPrompt extends ToolDefinition {
  _prompt?: () => string;
  _category?: string;
}

/** Attach a prompt function to a tool definition (non-destructive) */
export function withPrompt(tool: ToolDefinition, promptFn: () => string, category?: string): ToolDefinition {
  const t = tool as ToolWithPrompt;
  t._prompt = promptFn;
  if (category) t._category = category;
  return t;
}

/** Collect all tool prompt() outputs into a system prompt section */
export function buildToolPromptSection(tools: ToolDefinition[]): string {
  const lines: string[] = [];
  for (const tool of tools) {
    const t = tool as ToolWithPrompt;
    if (!t._prompt) continue;
    const text = t._prompt().trim();
    if (text) lines.push(`- **${t.name}**: ${text}`);
  }
  if (lines.length === 0) return "";
  return `\n\n## Tool Best Practices\n${lines.join("\n")}\n`;
}
