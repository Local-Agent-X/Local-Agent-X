/**
 * Shared internals for the worktree modules: the git runner, the in-memory
 * registry of active worktrees, and the temp base path. Imported by every
 * sibling worktree module so they all read/write the SAME registry.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLogger } from "../logger.js";

export const logger = createLogger("agency.worktree");

export interface WorktreeEntry {
  path: string;
  branch: string;
  baseBranch: string;  // The branch we'll merge back to (captured at creation)
  repoRoot: string;
  mergedSuccessfully: boolean;
}

export const WORKTREE_BASE = join(tmpdir(), "lax-worktrees");
export const activeWorktrees = new Map<string, WorktreeEntry>();

/**
 * Run git with an explicit args array via execFileSync (no shell).
 *
 * The previous implementation used `execSync(\`git ${cmd}\`)` which spawns
 * through cmd.exe on Windows and intermittently failed with
 * `spawnSync C:\\WINDOWS\\system32\\cmd.exe ENOENT` when the inherited
 * environment was missing ComSpec / SystemRoot. execFileSync calls git
 * directly with explicit env passthrough — no shell, no env-dependent
 * lookup, no quoting concerns.
 */
export function git(args: string[] | string, cwd?: string): string {
  const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
  try {
    return execFileSync("git", argv, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
      windowsHide: true,
      env: process.env,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${argv.join(" ")} failed: ${err.stderr || err.message}`);
  }
}
