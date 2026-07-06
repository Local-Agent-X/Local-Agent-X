/**
 * Hook System Types — event definitions and configuration interfaces.
 *
 * Hooks let users attach automated actions to agent tool events:
 * - command: run a shell command (e.g., "npm test" after write)
 * - http: POST to a localhost webhook URL
 */

// ── Hook Events (only events that are actually wired) ──

export type HookEvent =
  | "PreToolUse"         // Before a tool executes — can block it or rewrite its args
  | "PostToolUse"        // After a tool succeeds (runs after threat engine + budgeting)
  | "PostToolUseFailure" // After a tool fails
  | "Stop";              // When an op reaches a terminal state (fire-and-forget)

// ── Hook Definition ──

export interface HookDefinition {
  /** Which event triggers this hook */
  event: HookEvent;
  /** Optional name for logging */
  name?: string;
  /** Hook type: command (shell) or http (localhost webhook) */
  type: "command" | "http";
  /** For command hooks: the shell command to run. Access context via env vars: $HOOK_TOOL_NAME, $HOOK_TOOL_RESULT, $HOOK_EVENT */
  command?: string;
  /** For http hooks: localhost URL to POST to (external URLs are blocked) */
  url?: string;
  /** Optional tool name filter — only fire for this tool (e.g., "write", "bash") */
  toolFilter?: string;
  /** Timeout in seconds (default: 30) */
  timeout?: number;
  /** If true, hook runs detached (fire-and-forget, never blocks) */
  async?: boolean;
}

// ── Hook Result ──

export interface HookResult {
  /** Should execution continue? (false = block the tool call, PreToolUse only) */
  continue: boolean;
  /** Reason for blocking (shown to user/agent) */
  reason?: string;
  /** Output from the hook (log, command stdout, etc.) */
  output?: string;
  /** How long the hook took (ms) */
  durationMs?: number;
  /**
   * Replacement tool args (PreToolUse only) — a sync hook may emit a JSON
   * directive `{"rewriteArgs": {...}}` on stdout / in its response body to
   * modify the call instead of only vetoing it. The dispatcher re-runs the
   * full security + validation gate chain on the rewritten args before they
   * execute (see enforce-policy.ts), so a rewrite can never skip a screen the
   * original args passed.
   */
  rewriteArgs?: Record<string, unknown>;
}

// ── Hook Config (loaded from ~/.lax/hooks.json) ──

export interface HooksConfig {
  hooks: HookDefinition[];
}

// ── Hook Event Context (passed to hook execution) ──

export interface HookEventContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolError?: string;
  sessionId?: string;
  /** Execution context — "local" | "api" | "delegated" | "cron". Passed to security evaluation. */
  callContext?: string;
  /** Stop event only: the op that reached a terminal state. */
  opId?: string;
  /** Stop event only: the terminal status ("succeeded" | "failed" | ...). */
  opStatus?: string;
}
