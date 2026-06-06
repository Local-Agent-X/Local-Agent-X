// Builds the argv array for the `claude` CLI subprocess and writes the
// per-turn MCP config file when MCP routing is available. Kept separate
// from the spawn lifecycle so future arg changes (new flags, model-specific
// switches) don't require touching the streaming loop.

import { createLogger } from "../../logger.js";

const logger = createLogger("anthropic-client.stream-cli.args");

// Native CLI tools to disallow on every spawn, regardless of mode. Without
// this the model emits native tool calls in plan mode (the user sees the
// agent "exploring" their fs on a "hi"). LAX's tools come through MCP when
// MCP is wired below; the native set is always off — EXCEPT the entries in
// ENABLED_NATIVE_TOOLS below, in tool mode.
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

// Native Claude tools we DO let the model use in tool mode. WebSearch is
// Anthropic's server-side search, executed inside the CLI subprocess (results
// fold into the final text) — robust, no key, and the replacement for the flaky
// LAX web_search scraper. The stream parser must skip these so they aren't
// re-dispatched in LAX's outer loop; it imports this same set to stay in sync.
// WebFetch is intentionally NOT here: arbitrary URL fetches must route through
// LAX's web_fetch so the egress allowlist + data-lineage gate still apply.
export const ENABLED_NATIVE_TOOLS: readonly string[] = ["WebSearch"];

// Lookup form shared by BOTH stream parsers (cold-spawn stream-parse +
// warm-pool stream-prompt) so a native tool is skipped identically on every
// path instead of each parser keeping its own copy.
export const NATIVE_CLI_TOOL_SET: ReadonlySet<string> = new Set(ENABLED_NATIVE_TOOLS);

// When the LAX MCP search tool is also offered, the model prefers it over native
// WebSearch — so to actually route search to native we disallow it. web_fetch is
// left available; only search moves to native.
const FORCE_NATIVE_DISALLOW = ["mcp__lax__web_search"];

export function disallowedTools(textOnlyMode: boolean): string[] {
  // Plan mode can't execute tools anyway; keep the native set fully off there so
  // the orchestrator never "searches while thinking".
  if (textOnlyMode) return DISALLOWED_NATIVE_TOOLS;
  return [
    ...DISALLOWED_NATIVE_TOOLS.filter((t) => !ENABLED_NATIVE_TOOLS.includes(t)),
    ...FORCE_NATIVE_DISALLOW,
  ];
}

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
    "--disallowed-tools", disallowedTools(input.textOnlyMode).join(","),
  ];
}

export interface McpConfigSetupInput {
  textOnlyMode: boolean;
  laxToken: string;
  laxPort: number;
  sessionId?: string;
}

/**
 * Write a per-turn MCP config file pointing at the local LAX bridge and
 * return its path (or null when MCP can't be wired). Caller is responsible
 * for unlinking the file after the subprocess exits.
 */
export async function setupMcpConfig(input: McpConfigSetupInput): Promise<string | null> {
  if (input.textOnlyMode || !input.laxToken) return null;
  try {
    const { writeMcpConfig } = await import("../mcp-config.js");
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return writeMcpConfig({
      port: input.laxPort,
      token: input.laxToken,
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
