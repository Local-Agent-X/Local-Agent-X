/**
 * Where a shell call runs, for the approval path's disposable-delete check
 * (disposable-tree-delete.ts): relative targets resolve against it. Only for a
 * tool whose shell runs at its `_cwd`, else the workspace root — what
 * shell-tool.ts does. A tool that takes its own cwd argument (process_start)
 * is not resolved here, so its deletes keep the card.
 */
import { workspaceRoot } from "../config.js";
import { anchorsShellAtCwd } from "../tool-registry.js";
import { cwdOf } from "./internal-args.js";
import type { TreeDeleteScope } from "./disposable-tree-delete.js";

export function shellTreeDeleteScope(toolName: string, args: Record<string, unknown>, sessionId?: string): TreeDeleteScope | undefined {
  if (!anchorsShellAtCwd(toolName)) return undefined;
  return { cwd: cwdOf(args) || workspaceRoot(), sessionId };
}
