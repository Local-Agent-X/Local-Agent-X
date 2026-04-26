/**
 * Git Worktree Manager — creates isolated filesystem copies for agents.
 *
 * Flow:
 *   1. createWorktree(agentId) → creates branch + worktree in /tmp
 *   2. Agent runs with cwd override pointing to worktree
 *   3. mergeWorktree(agentId) → commits changes, merges back to stored base branch
 *   4. cleanupWorktree(agentId) → removes worktree + temp branch (preserves branch on conflict)
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLogger } from "../logger.js";
const logger = createLogger("agency.worktree");

interface WorktreeEntry {
  path: string;
  branch: string;
  baseBranch: string;  // The branch we'll merge back to (captured at creation)
  repoRoot: string;
  mergedSuccessfully: boolean;
}

const WORKTREE_BASE = join(tmpdir(), "sax-worktrees");
const activeWorktrees = new Map<string, WorktreeEntry>();

function git(cmd: string, cwd?: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: cwd || process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
      windowsHide: true,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${cmd} failed: ${err.stderr || err.message}`);
  }
}

/** Create an isolated worktree for an agent */
export function createWorktree(agentId: string): { path: string; branch: string } | null {
  try {
    const repoRoot = git("rev-parse --show-toplevel");
    const baseBranch = git("rev-parse --abbrev-ref HEAD", repoRoot);
    const branch = `agent/${agentId}`;
    const wtPath = join(WORKTREE_BASE, agentId);

    git(`branch ${branch} HEAD`, repoRoot);
    git(`worktree add "${wtPath}" ${branch}`, repoRoot);

    activeWorktrees.set(agentId, { path: wtPath, branch, baseBranch, repoRoot, mergedSuccessfully: false });
    logger.info(`[worktree] Created ${wtPath} on branch ${branch} (base: ${baseBranch})`);
    return { path: wtPath, branch };
  } catch (e) {
    logger.warn(`[worktree] Failed to create: ${(e as Error).message}`);
    return null;
  }
}

/** Merge agent's changes back to the stored base branch */
export function mergeWorktree(agentId: string): { merged: boolean; files: number; error?: string } {
  const wt = activeWorktrees.get(agentId);
  if (!wt) return { merged: false, files: 0, error: "No worktree found" };

  try {
    const status = git("status --porcelain", wt.path);
    if (!status) {
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: 0 };
    }

    git("add -A", wt.path);
    const fileCount = git("diff --cached --numstat", wt.path).split("\n").filter(Boolean).length;
    git(`commit -m "Agent ${agentId}: automated changes"`, wt.path);

    // Merge into the base branch that was current when the worktree was created
    try {
      git(`checkout ${wt.baseBranch}`, wt.repoRoot);
      git(`merge ${wt.branch} --no-edit`, wt.repoRoot);
      logger.info(`[worktree] Merged ${fileCount} files from ${agentId} into ${wt.baseBranch}`);
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: fileCount };
    } catch {
      git("merge --abort", wt.repoRoot);
      logger.warn(`[worktree] Merge conflict for ${agentId} — changes preserved on branch ${wt.branch}`);
      // Don't mark as merged — cleanupWorktree will preserve the branch
      cleanupWorktree(agentId);
      return { merged: false, files: fileCount, error: `Merge conflict. Changes preserved on branch ${wt.branch}` };
    }
  } catch (e) {
    logger.warn(`[worktree] Merge failed: ${(e as Error).message}`);
    cleanupWorktree(agentId);
    return { merged: false, files: 0, error: (e as Error).message };
  }
}

/** Remove worktree. Only deletes branch if merge succeeded. */
export function cleanupWorktree(agentId: string): void {
  const wt = activeWorktrees.get(agentId);
  if (!wt) return;

  try { git(`worktree remove "${wt.path}" --force`, wt.repoRoot); } catch { /* already gone */ }

  // Only delete branch if merge was successful — preserve it on conflict so user can resolve
  if (wt.mergedSuccessfully) {
    try { git(`branch -D ${wt.branch}`, wt.repoRoot); } catch { /* already merged/deleted */ }
  } else {
    logger.info(`[worktree] Preserving branch ${wt.branch} (unmerged changes)`);
  }

  activeWorktrees.delete(agentId);
  logger.info(`[worktree] Cleaned up ${agentId}`);
}

/** Get worktree path for an agent */
export function getWorktreePath(agentId: string): string | undefined {
  return activeWorktrees.get(agentId)?.path;
}

/** Cleanup all worktrees on shutdown */
export function cleanupAllWorktrees(): void {
  for (const [id] of activeWorktrees) cleanupWorktree(id);
}
