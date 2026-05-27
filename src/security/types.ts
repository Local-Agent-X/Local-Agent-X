// ── Tool call context ──

export type CallContext = "local" | "api" | "delegated" | "cron";

export type FileAccessMode = "workspace" | "common" | "unrestricted";

export interface ToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  callContext?: CallContext; // Where the call originates from
  // Server name when this tool came from an MCP server. Plumbing for
  // future policy work that may want to distinguish MCP-sourced calls
  // from native ones (e.g. tighter risk ceilings on third-party MCP
  // tools). No call site sets this yet — leave undefined for native.
  mcpServer?: string;
}

// Tools blocked in non-local contexts (API calls, delegated agents, cron jobs)
export const CONTEXT_RESTRICTED_TOOLS: Record<string, CallContext[]> = {
  bash: ["cron"],                         // Shell blocked in cron (no worktree isolation)
  browser: ["cron"],                      // No browser in automated jobs
  generate_image: ["cron"],               // Resource-intensive, block in cron
};

// Tools that require worktree isolation for delegated agents.
// If a delegated agent has a worktree (session in allowedPaths), these are safe.
// If not (e.g. Codex agents), block them to prevent uncontrolled writes.
export const WORKTREE_REQUIRED_TOOLS = new Set(["write", "edit", "bash"]);
