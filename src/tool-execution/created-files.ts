// Which files a tool call created, for the task-artifacts registry
// (data-lineage/task-artifacts.ts). Stat the targets BEFORE execute, so after a
// success only files the agent itself CREATED are enrolled: an overwrite of a
// pre-existing user file must never become a "task artifact". Best-effort like
// the freshness guard: any stat/resolve failure skips recording and never
// fails the tool call; a tool that creates nothing pays one Set lookup.

import { existsSync, lstatSync } from "node:fs";
import { workspaceRoot } from "../config.js";
import { recordAgentFolder, recordTaskArtifact } from "../data-lineage/task-artifacts.js";
import { shellCommandOf, waitsForShellCommand } from "../tool-registry.js";
import { statusOf } from "../tools/result-helpers.js";
import type { ToolResult } from "../types.js";
import { CREATE_CLASS, createTargetPath, shellCreateTargets, shellMkdirTargets } from "./create-target-path.js";
import { cwdOf } from "./internal-args.js";

export interface PendingCreates {
  /** A create-class call's output path, absent before execute. */
  target: string | null;
  /** A shell command's own write targets, absent before it ran. */
  shell: string[];
  /** The folders its `mkdir`s name, absent before it ran. */
  folders: string[];
}

export function statCreateTargets(toolName: string, args: Record<string, unknown>, sessionId: string | undefined): PendingCreates {
  const pending: PendingCreates = { target: null, shell: [], folders: [] };
  if (!sessionId) return pending;
  if (CREATE_CLASS.has(toolName)) {
    try {
      const target = createTargetPath(toolName, args);
      if (target && !existsSync(target)) pending.target = target;
    } catch { /* lineage is best-effort — never block the call */ }
  }
  const command = waitsForShellCommand(toolName) ? shellCommandOf(toolName, args) : undefined;
  if (command) {
    // Where shell-tool.ts runs the command.
    try { pending.shell = shellCreateTargets(command, cwdOf(args) || workspaceRoot()).filter((p) => !existsSync(p)); } catch { /* lineage is best-effort */ }
    try { pending.folders = shellMkdirTargets(command, cwdOf(args) || workspaceRoot()).filter((p) => !existsSync(p)); } catch { /* lineage is best-effort */ }
  }
  return pending;
}

/** SUCCESS-only means envelope status "ok" — not merely !isError: a `running`
 *  (async-started) result has produced no finished deliverable yet, and a
 *  failed call enrolls nothing even if it left partial bytes behind (like the
 *  external-ingestion mark). */
export function enrollCreatedFiles(sessionId: string | undefined, pending: PendingCreates, result: ToolResult): void {
  if (!sessionId || statusOf(result) !== "ok") return;
  if (pending.target) {
    try { recordTaskArtifact(sessionId, pending.target); } catch { /* lineage is best-effort */ }
  }
  // Absent before the command and a regular file after it: the command made it.
  for (const p of pending.shell) {
    try { if (lstatSync(p).isFile()) recordTaskArtifact(sessionId, p); } catch { /* not created: nothing to enroll */ }
  }
  for (const p of pending.folders) {
    try { if (lstatSync(p).isDirectory()) recordAgentFolder(sessionId, p); } catch { /* not created: nothing to enroll */ }
  }
}
