/**
 * Worktree lifecycle: create / merge / cleanup, for both the agency
 * delegated-agent path (createWorktree, branch `agent/<id>`) and autopilot
 * (createNamedWorktree, caller-supplied branch).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { activeWorktrees, git, logger, MAX_CONCURRENT_WORKTREES, WORKTREE_BASE, worktreeSlotAvailable } from "./worktree-core.js";
import { linkDirectoryInto, listCheckedOutBranches, unlinkSharedJunctions } from "./worktree-junctions.js";
import { claimRecoveredWorktree, forgetWorktreeOwnership, ownsWorktree, registerWorktreeOwnership } from "./worktree-recovery.js";

/** Create an isolated worktree for an agent */
export function createWorktree(agentId: string): { path: string; branch: string } | null {
  let repoRoot: string;
  let baseBranch: string;
  try {
    // Agency path: the repo is the one the app runs from — resolve it from the
    // ambient cwd EXPLICITLY (git() no longer defaults cwd to process.cwd()).
    repoRoot = git("rev-parse --show-toplevel", process.cwd());
    baseBranch = git("rev-parse --abbrev-ref HEAD", repoRoot);
  } catch (e) {
    logger.warn(`[worktree] Failed to resolve repository: ${(e as Error).message}`);
    return null;
  }
  const branch = `agent/${agentId}`;
  const recovered = claimRecoveredWorktree({
    name: agentId, branch, runId: agentId, repoRoot, baseBranch,
  });
  if (recovered) return { path: recovered.path, branch: recovered.branch };
  if (!worktreeSlotAvailable()) {
    logger.warn(`[worktree] cap reached (${activeWorktrees.size}/${MAX_CONCURRENT_WORKTREES}) — refusing new worktree for ${agentId}`);
    return null;
  }
  try {
    const wtPath = join(WORKTREE_BASE, agentId);

    git(["branch", branch, "HEAD"], repoRoot);
    git(["worktree", "add", wtPath, branch], repoRoot);

    const entry = registerWorktreeOwnership(agentId, {
      path: wtPath, branch, baseBranch, repoRoot, runId: agentId, mergedSuccessfully: false,
    }, agentId);
    activeWorktrees.set(agentId, entry);
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
  if (!ownsWorktree(wt)) {
    activeWorktrees.delete(agentId);
    return { merged: false, files: 0, error: "Worktree ownership changed; preserved without merge" };
  }

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

    // Merge into the base branch WITHOUT switching the user's live checkout.
    // The old path ran `git checkout <base>` in the parent repo root, which
    // yanked the user onto another branch (or failed spuriously when their
    // tree was mid-edit) and let two finishing agents race the checkout.
    // Instead, integrate base INTO the agent branch inside the isolated
    // worktree — conflicts stay here, never in the user's checkout — which
    // makes the agent branch a strict descendant of base, then advance base
    // by a pure fast-forward that cannot conflict.
    try {
      git(["merge", wt.baseBranch, "--no-edit"], wt.path);
      const mergedHead = git(["rev-parse", "HEAD"], wt.path);

      const parentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], wt.repoRoot);
      if (parentBranch === wt.baseBranch) {
        // The user is sitting on the base branch. Only reflect the change into
        // their working tree if it's clean: a --ff-only merge (no switch, no
        // merge commit) updates just the agent's files. If they have
        // uncommitted work, don't clobber it — leave the branch for a manual
        // merge (the worktree merge above already made agent/<id> a clean
        // fast-forward of base).
        if (git(["status", "--porcelain"], wt.repoRoot)) {
          throw new Error("parent working tree has uncommitted changes on the base branch");
        }
        git(["merge", "--ff-only", wt.branch], wt.repoRoot);
      } else {
        // Base branch is not checked out in the parent repo — advance its ref
        // directly. There is no working tree pointing at it to disturb.
        git(["update-ref", `refs/heads/${wt.baseBranch}`, mergedHead], wt.repoRoot);
      }
      logger.info(`[worktree] Merged ${fileCount} files from ${agentId} into ${wt.baseBranch}`);
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: fileCount };
    } catch (mergeErr) {
      // Abort any half-finished worktree-side merge so the preserved agent
      // branch is left clean for the user to merge manually. If no merge was
      // in progress (e.g. the parent tree was dirty), `git merge --abort`
      // errors benignly — swallow it and surface the REAL reason instead of
      // letting the abort's error mask it (the "MERGE_HEAD missing" confusion).
      try { git("merge --abort", wt.path); } catch { /* nothing in progress to abort */ }
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
  if (!ownsWorktree(wt)) {
    logger.warn(`[worktree] Ownership changed for ${agentId}; preserving worktree`);
    activeWorktrees.delete(agentId);
    return;
  }

  // Drop the shared node_modules junctions BEFORE `git worktree remove --force`
  // so the recursive delete can't traverse into the parent repo's real deps.
  const stuck = unlinkSharedJunctions(wt.path);
  if (stuck.length) {
    logger.error(`[worktree] Refusing to remove ${agentId}: live node_modules junction(s) still present (${stuck.join(", ")}). Worktree left on disk to protect the parent node_modules.`);
    activeWorktrees.delete(agentId);
    return;
  }

  forgetWorktreeOwnership(wt);
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
  for (const [id, wt] of activeWorktrees) {
    if (!ownsWorktree(wt)) {
      activeWorktrees.delete(id);
      continue;
    }
    let dirty = "";
    try { dirty = git(["status", "--porcelain"], wt.path); } catch {
      logger.warn(`[worktree] Could not inspect ${id} during shutdown; preserving it`);
      continue;
    }
    if (dirty) {
      try {
        git(["add", "-A"], wt.path);
        git(["commit", "-m", `Checkpoint ${id}: preserve work in progress`], wt.path);
        wt.recovered = true;
        logger.info(`[worktree] Checkpointed dirty worktree ${id} for recovery`);
      } catch (e) {
        logger.warn(`[worktree] Could not checkpoint ${id}; preserving directory: ${(e as Error).message}`);
      }
      continue;
    }
    let integrated = wt.mergedSuccessfully;
    if (!integrated) {
      try {
        git(["merge-base", "--is-ancestor", wt.branch, wt.baseBranch], wt.repoRoot);
        integrated = true;
      } catch { /* clean branch still carries unfinished commits */ }
    }
    if (integrated && !wt.recovered) cleanupWorktree(id);
    else {
      wt.recovered = true;
      logger.info(`[worktree] Preserving clean unmerged worktree ${id} for recovery`);
    }
  }
}

// ── Named worktrees (autopilot) ─────────────────────────────────────────
//
// createWorktree() above derives branch name as `agent/<id>` and is called
// only from the agency delegated-agent path. Autopilot needs a different
// branch prefix (and doesn't want to be subject to the agent- session-id
// path-rewrite logic in tool-execution/). createNamedWorktree() lets the
// caller supply both the map key (name) and the full branch name.

/** Upper bound on `<branch>-N` probes before giving up. Reaching it means that
 *  many unmerged leftovers of ONE name — something upstream is wrong, and a
 *  loud creation failure (via the caller's catch) beats an endless probe. */
const MAX_STALE_BRANCH_SUFFIX = 20;

function branchExists(branch: string, repoRoot: string): boolean {
  try { git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot); return true; }
  catch { return false; }
}

/**
 * Preflight for createNamedWorktree: the requested branch may already exist
 * from a PREVIOUS run. auto-build names `autobuild/c<N>` from the chunk number
 * alone, so run N+1 collides with run N; the recovery path only re-adopts a
 * worktree whose runId matches, and a merged-but-unswept branch has no
 * worktree at all — so `git branch <name> HEAD` fails and takes the whole
 * worktree creation with it.
 *
 * Policy mirrors cleanupWorktree: delete the leftover ONLY when git proves it
 * fully merged (`-d`, never `-D`) and no worktree has it checked out. Otherwise
 * preserve it untouched and cut on the first free `<name>-2`, `<name>-3`, … so
 * unmerged work is never lost and creation never fails on a leftover. Returns
 * the branch name to actually create.
 */
function resolveStaleBranchName(branchName: string, repoRoot: string): string {
  if (!branchExists(branchName, repoRoot)) return branchName;
  let checkedOut: Set<string>;
  try { checkedOut = listCheckedOutBranches(repoRoot); }
  catch { checkedOut = new Set(); } // unknown → `-d` below still refuses a checked-out branch
  // Why `candidate` cannot be (re)created, or null when it is free: absent, or
  // a merged leftover that `-d` just removed. Applied to the suffixes too, so a
  // merged `<name>-2` from an earlier side-step is reclaimed, not skipped.
  const blocker = (candidate: string): string | null => {
    if (!branchExists(candidate, repoRoot)) return null;
    if (checkedOut.has(candidate)) return "checked out by another worktree";
    try {
      git(["branch", "-d", candidate], repoRoot);
      logger.info(`[worktree] Deleted stale merged branch ${candidate} so its name can be reused`);
      return null;
    } catch {
      return "unmerged, git branch -d refused";
    }
  };
  const reason = blocker(branchName);
  if (reason === null) return branchName;
  for (let n = 2; n <= MAX_STALE_BRANCH_SUFFIX; n++) {
    const candidate = `${branchName}-${n}`;
    if (blocker(candidate) !== null) continue;
    logger.warn(`[worktree] Stale branch ${branchName} preserved (${reason}); creating worktree on ${candidate} instead`);
    return candidate;
  }
  throw new Error(`no free branch name for ${branchName}: ${MAX_STALE_BRANCH_SUFFIX} stale suffixes already exist`);
}

/**
 * Create an isolated worktree with caller-supplied branch name.
 *
 * The returned `branch` is the one actually created. It differs from
 * `branchName` only when an UNMERGED (or checked-out) leftover of that name had
 * to be preserved (see resolveStaleBranchName) — callers must read it rather
 * than assume the name they asked for.
 * Used by autopilot + self-edit + update (which edit the LAX repo itself, so
 * process.cwd() IS that repo) and by auto-build's parallel path (which builds
 * the USER's app in a DIFFERENT repo, inside the long-lived LAX server process
 * where cwd is NOT that repo).
 *
 * `repoRoot` (optional) is the repo this worktree is cut from. When given, EVERY
 * git op that establishes the worktree is anchored to it, and the git-resolved
 * toplevel is STORED in the registry so all downstream lifecycle ops (merge /
 * commit / cleanup — which read `wt.repoRoot` or `wt.path`, never process.cwd())
 * target the SAME repo. When ABSENT the resolution derives from process.cwd()
 * exactly as before, so the LAX-editing callers are byte-identical.
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
  repoRoot?: string,
  runId = name,
): { path: string; branch: string; baseBranch: string } | null {
  let resolvedRoot: string;
  let baseBranch: string;
  try {
    // repoRoot given → the caller's repo (auto-build's user app); absent → the
    // LAX repo the server runs from. Name the discovery cwd explicitly either
    // way — git() no longer falls back to process.cwd() on its own.
    resolvedRoot = git("rev-parse --show-toplevel", repoRoot ?? process.cwd());
    baseBranch = git("rev-parse --abbrev-ref HEAD", resolvedRoot);
  } catch (e) {
    logger.warn(`[worktree] Failed to resolve named worktree repository: ${(e as Error).message}`);
    return null;
  }
  const recovered = claimRecoveredWorktree({
    name, branch: branchName, runId, repoRoot: resolvedRoot, baseBranch,
  });
  if (recovered) {
    return { path: recovered.path, branch: recovered.branch, baseBranch: recovered.baseBranch };
  }
  if (!worktreeSlotAvailable()) {
    logger.warn(`[worktree] cap reached (${activeWorktrees.size}/${MAX_CONCURRENT_WORKTREES}) — refusing new worktree for ${name}`);
    return null;
  }
  try {
    // Resolve the toplevel of the repo this worktree belongs to. `repoRoot`
    // undefined → cwd (today's behavior); provided → the caller's repo, even
    // when it's a subdir (git normalizes to the toplevel + strips symlinks).
    const wtPath = join(WORKTREE_BASE, name);

    // A leftover branch of this name from an earlier run must not fail the
    // whole creation — reuse the name if merged, side-step it if not.
    const branch = resolveStaleBranchName(branchName, resolvedRoot);
    git(["branch", branch, "HEAD"], resolvedRoot);
    git(["worktree", "add", wtPath, branch], resolvedRoot);

    // Share node_modules + ari kernel package node_modules with the parent.
    // Autopilot edits source; the build needs deps that aren't tracked.
    linkDirectoryInto(join(resolvedRoot, "node_modules"), join(wtPath, "node_modules"));
    // ari kernel sub-packages each have their own node_modules from npm
    // workspaces. Link them too if present, so tsup builds can find typescript.
    try {
      const pkgsDir = join(resolvedRoot, "packages");
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

    const entry = registerWorktreeOwnership(name, {
      path: wtPath,
      branch,
      baseBranch,
      repoRoot: resolvedRoot,
      runId,
      mergedSuccessfully: false,
    }, runId);
    activeWorktrees.set(name, entry);
    logger.info(`[worktree] Created named worktree ${wtPath} on branch ${branch} (base: ${baseBranch}, repo: ${resolvedRoot})`);
    return { path: wtPath, branch, baseBranch };
  } catch (e) {
    logger.warn(`[worktree] Failed to create named worktree ${name}: ${(e as Error).message}`);
    return null;
  }
}
