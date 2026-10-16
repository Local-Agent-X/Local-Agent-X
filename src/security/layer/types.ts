// ── Tool call context ──

import { CAPABILITY_CLASS_MEMBERS } from "../../tool-registry.js";

export type CallContext = "local" | "api" | "delegated" | "cron";

export type FileAccessMode = "workspace" | "common" | "unrestricted";

// Inline-eval interpreter-escape policy (R4-11/R4-13). DELIBERATELY separate
// from FileAccessMode: file-access breadth and the inline-interpreter escape
// hatch are different security concerns. Welding them onto one enum let a
// file-access default flip silently disable the shell defense. "refuse" forces
// a script file; "allow" permits inline `python -c` / `node -e` bodies.
export type InlineEvalPolicy = "refuse" | "allow";

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

/**
 * Runs with no one watching that work in a folder provisioned for them: a
 * delegated agent (agency/agent-workspace.ts) and a scheduled job (its
 * missions folder, server/background-jobs/cron-runner.ts). Both answer to the
 * same rules: WORKTREE_REQUIRED_TOOLS through delegated-worktree-gate.ts, and
 * shell through the unattended shell gate.
 */
export const WORKER_CONTEXTS: ReadonlySet<CallContext> = new Set<CallContext>(["delegated", "cron"]);

// Tools blocked in non-local contexts (API calls, delegated agents, cron jobs)
export const CONTEXT_RESTRICTED_TOOLS: Record<string, CallContext[]> = {
  browser: ["cron"],                      // No browser in automated jobs
  generate_image: ["cron"],               // Resource-intensive, block in cron
  edit_image: ["cron"],                    // Resource-intensive off-box edit, block in cron
};

// Tools that can need worktree isolation in a WORKER_CONTEXTS run: every tool
// that writes files on some call, and every shell tool — the capability classes,
// so a synonym (ari_file, edit_lines, process_start) or a new tool joins by its
// own policy row. The security layer judges each CALL (a spreadsheet read needs
// nothing); this name-level set is for the surfaces that list tools.
export const WORKTREE_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  ...CAPABILITY_CLASS_MEMBERS["workspace-write"],
  ...CAPABILITY_CLASS_MEMBERS.shell,
]);
