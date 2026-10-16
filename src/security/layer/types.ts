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

// Tools that require worktree isolation in a WORKER_CONTEXTS run.
// If the run has a worktree or work root (session in allowedPaths), these are safe.
// If not (e.g. Codex agents), block them to prevent uncontrolled writes.
//
// Keyed on workspace-write + shell CAPABILITY membership, not literal names, so
// the synonyms (ari_file write, process_start) require
// worktree isolation identically to their canonical equivalents (write/edit/bash).
// Canonical {write, edit, bash} are preserved; the synonyms are newly added.
export const WORKTREE_REQUIRED_TOOLS = new Set([
  "write", "edit", "ari_file",
  ...CAPABILITY_CLASS_MEMBERS.shell,
  "edit_lines", "multi_edit", "bulk_replace", "delete_file", // registered edit/delete synonyms — same blast radius as write/edit
  "restore_file", // re-materializes task-trashed bytes on disk — a write under another spelling
]);
