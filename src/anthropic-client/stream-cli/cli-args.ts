// Builds the argv array for the `claude` CLI subprocess and writes the
// per-turn MCP config file when MCP routing is available. Kept separate
// from the spawn lifecycle so future arg changes (new flags, model-specific
// switches) don't require touching the streaming loop.

import { createLogger } from "../../logger.js";

const logger = createLogger("anthropic-client.stream-cli.args");

// Native CLI tools to disallow on every spawn, regardless of mode. Without
// this the model emits native tool calls in plan mode (the user sees the
// agent "exploring" their fs on a "hi"). LAX's tools come through MCP when
// MCP is wired below; the native set is always off.
const DISALLOWED_NATIVE_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "TodoWrite", "ToolSearch",
  "NotebookEdit", "Task", "AskUserQuestion", "Skill",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Monitor", "TaskOutput", "TaskStop",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger",
];

export interface CliArgsInput {
  model: string;
  /** When false, --permission-mode plan + no MCP bridge. */
  textOnlyMode: boolean;
}

export function buildCliArgs(input: CliArgsInput): string[] {
  return [
    "-p", "--model", input.model, "--output-format", "stream-json", "--verbose",
    // Emit stream_event frames (content_block_delta, text_delta, etc.) so we
    // can yield text token-by-token instead of waiting for each complete
    // content block. Without this, the UI sees nothing until the model is
    // fully done or hits a tool call.
    "--include-partial-messages",
    "--no-session-persistence",
    // Text-only (orchestration): plan mode — Claude thinks but can't execute tools
    // Tool mode: bypass all permissions so tools execute immediately
    "--permission-mode", input.textOnlyMode ? "plan" : "bypassPermissions",
    "--disallowed-tools", DISALLOWED_NATIVE_TOOLS.join(","),
  ];
}

export interface McpConfigSetupInput {
  textOnlyMode: boolean;
  saxToken: string;
  saxPort: number;
  sessionId?: string;
}

/**
 * Write a per-turn MCP config file pointing at the local SAX bridge and
 * return its path (or null when MCP can't be wired). Caller is responsible
 * for unlinking the file after the subprocess exits.
 */
export async function setupMcpConfig(input: McpConfigSetupInput): Promise<string | null> {
  if (input.textOnlyMode || !input.saxToken) return null;
  try {
    const { writeMcpConfig } = await import("../mcp-config.js");
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return writeMcpConfig({
      port: input.saxPort,
      token: input.saxToken,
      sessionId: input.sessionId,
      tag,
    });
  } catch (e) {
    logger.warn(`[anthropic-cli] MCP config setup failed, falling back to text-mode: ${(e as Error).message}`);
    return null;
  }
}

/** Best-effort unlink — caller calls in finally / on exit. */
export async function cleanupMcpConfig(path: string | null): Promise<void> {
  if (!path) return;
  try {
    const fs = await import("node:fs");
    fs.unlinkSync(path);
  } catch { /* already gone */ }
}
