/**
 * Worktree lifecycle: create / merge / cleanup, for both the agency
 * delegated-agent path (createWorktree, branch `agent/<id>`) and autopilot
 * (createNamedWorktree, caller-supplied branch).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { activeWorktrees, git, logger, WORKTREE_BASE } from "./worktree-core.js";
import { linkDirectoryInto, unlinkSharedJunctions } from "./worktree-junctions.js";

/** Create an isolated worktree for an agent */
export function createWorktree(agentId: string): { path: string; branch: string } | null {
  try {
    const repoRoot = git("rev-parse --show-toplevel");
    const baseBranch = git("rev-parse --abbrev-ref HEAD", repoRoot);
    const branch = `agent/${agentId}`;
    const wtPath = join(WORKTREE_BASE, agentId);

    git(["branch", branch, "HEAD"], repoRoot);
    git(["worktree", "add", wtPath, branch], repoRoot);

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
    if (status) {
      git("add -A", wt.path);
      git(["commit", "-m", `Agent ${agentId}: automated changes`], wt.path);
    }

    // Merge delta = base tip vs branch head, NOT the working-tree status. A
    // worktree whose changes are already committed (an update merge, a surgeon
    // that commits its own work) has a clean status but still carries commits
    // the base branch needs — short-circuiting on clean status would delete
    // the branch and silently drop them.
    const baseSha = git(["rev-parse", wt.baseBranch], wt.repoRoot);
    const headSha = git(["rev-parse", "HEAD"], wt.path);
    const fileCount = baseSha === headSha
      ? 0
      : git(["diff", "--name-only", `${baseSha}...${headSha}`], wt.path).split("\n").filter(Boolean).length;
    if (fileCount === 0) {
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: 0 };
    }

    // Merge into the base branch that was current when the worktree was created
    try {
      git(["checkout", wt.baseBranch], wt.repoRoot);
      git(["merge", wt.branch, "--no-edit"], wt.repoRoot);
      logger.info(`[worktree] Merged ${fileCount} files from ${agentId} into ${wt.baseBranch}`);
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: fileCount };
    } catch (mergeErr) {
      // Roll back the merge. If it failed BEFORE git entered merge state (no
      // MERGE_HEAD — e.g. the checkout was refused, or the merge was rejected
      // pre-merge), `git merge --abort` itself errors with "no merge to abort";
      // that's benign, so swallow it and surface the REAL reason instead of
      // letting the abort's error mask it (the "MERGE_HEAD missing" confusion).
      try { git("merge --abort", wt.repoRoot); } catch { /* nothing in progress to abort */ }
      const reason = (mergeErr as Error).message;
      logger.warn(`[worktree] Merge failed for ${agentId} — changes preserved on branch ${wt.branch}: ${reason}`);
      // Don't mark as merged — cleanupWorktree will preserve the branch
      cleanupWorktree(agentId);
      return { merged: false, files: fileCount, error: `Merge failed (changes preserved on branch ${wt.branch}): ${reason}` };
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

  // Drop the shared node_modules junctions BEFORE `git worktree remove --force`
  // so the recursive delete can't traverse into the parent repo's real deps.
  const stuck = unlinkSharedJunctions(wt.path);
  if (stuck.length) {
    logger.error(`[worktree] Refusing to remove ${agentId}: live node_modules junction(s) still present (${stuck.join(", ")}). Worktree left on disk to protect the parent node_modules.`);
    activeWorktrees.delete(agentId);
    return;
  }

  try { git(["worktree", "remove", wt.path, "--force"], wt.repoRoot); } catch { /* already gone */ }

  // Only delete branch if merge was successful — preserve it on conflict so user can resolve
  if (wt.mergedSuccessfully) {
    try { git(["branch", "-D", wt.branch], wt.repoRoot); } catch { /* already merged/deleted */ }
  } else {
    logger.info(`[worktree] Preserving branch ${wt.branch} (unmerged changes)`);
  }

  activeWorktrees.delete(agentId);
  logger.info(`[worktree] Cleaned up ${agentId}`);
}

/** Cleanup all worktrees on shutdown */
export function cleanupAllWorktrees(): void {
  for (const [id] of activeWorktrees) cleanupWorktree(id);
}

// ── Named worktrees (autopilot) ─────────────────────────────────────────
//
// createWorktree() above derives branch name as `agent/<id>` and is called
// only from the agency delegated-agent path. Autopilot needs a different
// branch prefix (and doesn't want to be subject to the agent- session-id
// path-rewrite logic in tool-executor.ts). createNamedWorktree() lets the
// caller supply both the map key (name) and the full branch name.

/**
 * Create an isolated worktree with caller-supplied branch name.
 * Used by autopilot — agency uses createWorktree() above.
 *
 * After `git worktree add` the new dir has only git-tracked files. Autopilot
 * needs `npm run build` to work, which requires node_modules and (for ari
 * sub-package builds) the prebuilt dist/. We junction both from the parent
 * repo so the build inside the worktree has everything it needs without a
 * full `npm install` per shift.
 */
export function createNamedWorktree(
  name: string,
  branchName: string,
): { path: string; branch: string; baseBranch: string } | null {
  try {
    const repoRoot = git("rev-parse --show-toplevel");
    const baseBranch = git("rev-parse --abbrev-ref HEAD", repoRoot);
    const wtPath = join(WORKTREE_BASE, name);

    git(["branch", branchName, "HEAD"], repoRoot);
    git(["worktree", "add", wtPath, branchName], repoRoot);

    // Share node_modules + ari kernel package node_modules with the parent.
    // Autopilot edits source; the build needs deps that aren't tracked.
    linkDirectoryInto(join(repoRoot, "node_modules"), join(wtPath, "node_modules"));
    // ari kernel sub-packages each have their own node_modules from npm
    // workspaces. Link them too if present, so tsup builds can find typescript.
    try {
      const pkgsDir = join(repoRoot, "packages");
      if (existsSync(pkgsDir)) {
        for (const pkg of readdirSync(pkgsDir)) {
          const pkgRoot = join(pkgsDir, pkg);
          if (!statSync(pkgRoot).isDirectory()) continue;
          const srcNm = join(pkgRoot, "node_modules");
          const dstNm = join(wtPath, "packages", pkg, "node_modules");
          linkDirectoryInto(srcNm, dstNm);
        }
      }
    } catch (e) {
      logger.warn(`[worktree] Failed to link package node_modules: ${(e as Error).message}`);
    }

    activeWorktrees.set(name, { path: wtPath, branch: branchName, baseBranch, repoRoot, mergedSuccessfully: false });
    logger.info(`[worktree] Created named worktree ${wtPath} on branch ${branchName} (base: ${baseBranch})`);
    return { path: wtPath, branch: branchName, baseBranch };
  } catch (e) {
    logger.warn(`[worktree] Failed to create named worktree ${name}: ${(e as Error).message}`);
    return null;
  }
}
