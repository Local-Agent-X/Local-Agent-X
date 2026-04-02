import type { ToolDefinition, ToolResult } from "./types.js";

// ── Category & Enhanced Types ──

export type ToolCategory =
  | "filesystem"
  | "web"
  | "search"
  | "agent"
  | "office"
  | "communication"
  | "database"
  | "media"
  | "system"
  | "planning";

export interface EnhancedToolDefinition extends ToolDefinition {
  category: ToolCategory;
  tags?: string[];
  /** Safe to run concurrently with other tools (default false) */
  concurrencySafe?: boolean;
  /** Tool only reads state, never mutates */
  readOnly?: boolean;
  /** Tool performs destructive/irreversible operations */
  isDestructive?: boolean;
  /** Dynamic check — return false to hide tool from current context */
  isEnabled?: () => boolean;
  /** Validate args before execute(); avoids wasted API calls */
  validateInput?: (args: Record<string, unknown>) => { valid: boolean; error?: string };
  /** Max chars in result before truncation (default 50 000) */
  maxResultSize?: number;
  /** Natural-language usage instructions injected into system prompt */
  prompt?: () => string;
  /** Exclude from initial tool list; discovered via tool_search */
  defer?: boolean;
  /** Keywords that help tool_search find this tool */
  searchHint?: string;
}

// ── Defaults ──

const DEFAULTS: Pick<EnhancedToolDefinition, "concurrencySafe" | "readOnly" | "isDestructive" | "maxResultSize" | "defer"> = {
  concurrencySafe: false,
  readOnly: false,
  isDestructive: false,
  maxResultSize: 50_000,
  defer: false,
};

// ── Helpers ──

/**
 * Wrap a plain ToolDefinition with enhanced metadata.
 * Missing fields are filled from sensible defaults.
 */
export function enhanceTool(
  base: ToolDefinition,
  enhancements: Partial<Omit<EnhancedToolDefinition, keyof ToolDefinition>> & Pick<EnhancedToolDefinition, "category">,
): EnhancedToolDefinition {
  return { ...DEFAULTS, ...base, ...enhancements };
}

/**
 * Collect every tool's `prompt()` output into a single system-prompt section.
 * Skips tools that are deferred, disabled, or lack a prompt function.
 */
export function buildToolPromptSection(tools: EnhancedToolDefinition[]): string {
  const lines: string[] = [];

  for (const tool of tools) {
    if (tool.defer) continue;
    if (tool.isEnabled && !tool.isEnabled()) continue;
    if (!tool.prompt) continue;

    const text = tool.prompt().trim();
    if (text.length === 0) continue;

    lines.push(`## ${tool.name}\n${text}`);
  }

  if (lines.length === 0) return "";
  return `# Tool Usage\n\n${lines.join("\n\n")}\n`;
}

export type { ToolDefinition, ToolResult };
