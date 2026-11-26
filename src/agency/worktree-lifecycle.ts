/**
 * Worktree lifecycle: create / merge / cleanup, for both the agency
 * delegated-agent path (createWorktree, branch `agent/<id>`) and autopilot
 * (createNamedWorktree, caller-supplied branch).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { activeWorktrees, git, commitWithFallbackIdentity, logger, MAX_CONCURRENT_WORKTREES, reRecordUnchangedFiles, WORKTREE_BASE, worktreeRemoveArgs, worktreeSlotAvailable } from "./worktree-core.js";
import { hasVanishedWorktreeAt, linkDirectoryInto, listCheckedOutBranches, unlinkSharedJunctions } from "./worktree-junctions.js";
import { claimRecoveredWorktree, forgetWorktreeOwnership, ownsWorktree, registerWorktreeOwnership } from "./worktree-recovery.js";
import { findMergeOverlaps, noteMerged, overlapSummary, type MergeOverlap } from "./merge-overlap.js";
import { concludeResolvedMerge, type MergeConflictResolver } from "./worktree-merge-conflicts.js";
import { removeTreeRetrying } from "../util/remove-tree.js";

/** Cut `branch` at HEAD and check it out at `wtPath`. When the checkout is
 *  refused (a crashed run left a directory at the path), the branch just cut
 *  is deleted again, so a failed attempt leaves nothing behind.
 *
 *  A worktree whose folder vanished (deleted from outside, a temp cleaner)
 *  stays on git's record, and git refuses the path until that record goes:
 *  every resume of a build then cost the chunk its worktree, and it was built
 *  without isolation instead (label-check chunk 3, 2026-11-22). `--force`
 *  replaces exactly that one record, and is passed only when the folder is
 *  gone and git still lists it. The old worktree's branch is left as it is. */
function addWorktreeOnNewBranch(repoRoot: string, wtPath: string, branch: string): void {
  const vanished = hasVanishedWorktreeAt(repoRoot, wtPath);
  if (vanished) logger.warn(`[worktree] ${wtPath} is on git's record but its folder is gone; replacing the record`);
  git(["branch", branch, "HEAD"], repoRoot);
  try {
    git(["worktree", "add", ...(vanished ? ["--force"] : []), wtPath, branch], repoRoot);
  } catch (e) {
    // `-d`, never `-D`: the branch sits at HEAD, so only a branch that gained
    // commits in between survives, and the add's error is the one reported.
    try { git(["branch", "-d", branch], repoRoot); } catch { /* kept: it carries commits */ }
    throw e;
  }
}

/** Create an isolated worktree for an agent, of `repoDir`'s repository (a
 *  user project the agent was sent to) or, by default, of the repo the app
 *  runs from. */
export function createWorktree(agentId: string, repoDir?: string): { path: string; branch: string; repoRoot: string } | null {
  let repoRoot: string;
  let baseBranch: string;
  try {
    // Resolve the repo from an EXPLICIT cwd (git() no longer defaults cwd to
    // process.cwd()).
    repoRoot = git("rev-parse --show-toplevel", repoDir ?? process.cwd());
    baseBranch = git("rev-parse --abbrev-ref HEAD", repoRoot);
  } catch (e) {
    logger.warn(`[worktree] Failed to resolve repository: ${(e as Error).message}`);
    return null;
  }
  const branch = `agent/${agentId}`;
  const recovered = claimRecoveredWorktree({
    name: agentId, branch, runId: agentId, repoRoot, baseBranch,
  });
  if (recovered) return { path: recovered.path, branch: recovered.branch, repoRoot };
  if (!worktreeSlotAvailable()) {
    logger.warn(`[worktree] cap reached (${activeWorktrees.size}/${MAX_CONCURRENT_WORKTREES}) — refusing new worktree for ${agentId}`);
    return null;
  }
  try {
    const wtPath = join(WORKTREE_BASE, agentId);
    addWorktreeOnNewBranch(repoRoot, wtPath, branch);

    const entry = registerWorktreeOwnership(agentId, {
      path: wtPath, branch, baseBranch, repoRoot, runId: agentId, mergedSuccessfully: false,
    }, agentId);
    activeWorktrees.set(agentId, entry);
    logger.info(`[worktree] Created ${wtPath} on branch ${branch} (base: ${baseBranch})`);
    return { path: wtPath, branch, repoRoot };
  } catch (e) {
    logger.warn(`[worktree] Failed to create: ${(e as Error).message}`);
    return null;
  }
}

/** Merge agent's changes back to the stored base branch. A conflict ends the
 *  merge with the branch kept, unless `resolveConflicts` settles every
 *  conflicted file by a rule of the caller's (worktree-merge-conflicts.ts). */
export function mergeWorktree(
  agentId: string,
  opts: { resolveConflicts?: MergeConflictResolver } = {},
): { merged: boolean; files: number; error?: string; overlaps?: MergeOverlap[]; overlapNote?: string } {
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
      commitWithFallbackIdentity(["-m", `Agent ${agentId}: automated changes`], wt.path);
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
    // What this merge overlaps, read before the base is merged in: files both
    // sides changed (git merges those cleanly and tells nobody) and files
    // another live agent claims (merge-overlap.ts). Reported, never a block.
    const mergeFacts = { repoRoot: wt.repoRoot, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, baseSha, headSha };
    const { changed, overlaps } = findMergeOverlaps(mergeFacts);
    try {
      try {
        git(["merge", wt.baseBranch, "--no-edit"], wt.path);
      } catch (conflict) {
        if (!concludeResolvedMerge(wt.path, opts.resolveConflicts)) throw conflict;
      }
      const mergedHead = git(["rev-parse", "HEAD"], wt.path);

      const parentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], wt.repoRoot);
      if (parentBranch === wt.baseBranch) {
        // The user is sitting on the base branch. A --ff-only merge (no
        // switch, no merge commit) updates just the agent's files, and git
        // refuses it on its own when one of them has an uncommitted edit, so
        // the user's work is never clobbered. An edit to a file the merge does
        // not touch never blocks it: requiring a clean tree set a reviewed
        // chunk aside because the build's lead had edited its own spec
        // mid-build (label-check-grok, 2026-11-25). Untracked files never
        // block either (a stray .builtref stopped every in-app update,
        // 2026-11-04), nor does a file rewritten with its same content
        // (label-check, 2026-11-23; worktree-core.ts).
        reRecordUnchangedFiles(wt.repoRoot);
        try {
          git(["merge", "--ff-only", wt.branch], wt.repoRoot);
        } catch (ffErr) {
          const dirty = git(["status", "--porcelain", "--untracked-files=no"], wt.repoRoot);
          if (!dirty) throw ffErr;
          throw new Error(`parent working tree has uncommitted changes to files this merge changes (${dirty.split("\n").map((l) => l.trim().replace(/^\S+\s+/, "")).join(", ")})`);
        }
      } else {
        // Base branch is not checked out in the parent repo — advance its ref
        // directly. There is no working tree pointing at it to disturb.
        git(["update-ref", `refs/heads/${wt.baseBranch}`, mergedHead], wt.repoRoot);
      }
      logger.info(`[worktree] Merged ${fileCount} files from ${agentId} into ${wt.baseBranch}`);
      noteMerged(mergeFacts, changed, overlaps);
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: fileCount, ...(overlaps.length ? { overlaps, overlapNote: overlapSummary(overlaps) } : {}) };
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
  try { git(worktreeRemoveArgs(wt.path), wt.repoRoot); }
  catch (e) {
    // Gone already is fine. A copy git could not delete stays in Temp and the
    // next build has to work around it: say so, never "Cleaned up".
    if (existsSync(wt.path)) {
      logger.warn(`[worktree] ${agentId} could not be removed and is still on disk at ${wt.path}: ${(e as Error).message.split("\n")[0]}`);
      // Git let it go and a held file stopped the delete: try again as the
      // handles close (its junctions were unlinked above).
      if (!existsSync(join(wt.path, ".git"))) void removeTreeRetrying(wt.path, (reason) => logger.warn(`[worktree] ${wt.path} is still on disk: ${reason}`));
    }
  }

  // Only delete branch if merge was successful — preserve it on conflict so user can resolve
  if (wt.mergedSuccessfully) {
    try { git(["branch", "-D", wt.branch], wt.repoRoot); } catch { /* already merged/deleted */ }
  } else {
    logger.info(`[worktree] Preserving branch ${wt.branch} (unmerged changes)`);
  }

  activeWorktrees.delete(agentId);
  if (!existsSync(wt.path)) logger.info(`[worktree] Cleaned up ${agentId}`);
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
        commitWithFallbackIdentity(["-m", `Checkpoint ${id}: preserve work in progress`], wt.path);
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
export function resolveStaleBranchName(branchName: string, repoRoot: string): string {
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
 * The folder for a new worktree: `preferred`, or the first free `<preferred>-2`,
 * `-3`, … when a folder is already there. A cleaned-up worktree's folder can
 * outlive its git registration on Windows (a process still holding a file in
 * it), and `git worktree add` refuses an existing path: the next run's chunk
 * then built without isolation (label-check, 2026-11-21). The leftover is
 * never deleted here: it is not this run's to judge.
 */
function freeWorktreePath(preferred: string): string {
  if (!existsSync(preferred)) return preferred;
  for (let n = 2; n <= MAX_STALE_BRANCH_SUFFIX; n++) {
    const candidate = `${preferred}-${n}`;
    if (!existsSync(candidate)) {
      logger.warn(`[worktree] ${preferred} is still on disk from an earlier worktree; using ${candidate}`);
      return candidate;
    }
  }
  throw new Error(`no free worktree folder for ${preferred}: ${MAX_STALE_BRANCH_SUFFIX} leftovers already exist`);
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
): { path: string; branch: string; baseBranch: string; recovered?: true } | null {
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
  // `recovered`: the tree holds a crashed run's work (worktree-recovery.ts),
  // which the caller may need to say to whoever works in it.
  if (recovered) {
    return { path: recovered.path, branch: recovered.branch, baseBranch: recovered.baseBranch, recovered: true };
  }
  if (!worktreeSlotAvailable()) {
    logger.warn(`[worktree] cap reached (${activeWorktrees.size}/${MAX_CONCURRENT_WORKTREES}) — refusing new worktree for ${name}`);
    return null;
  }
  try {
    // Resolve the toplevel of the repo this worktree belongs to. `repoRoot`
    // undefined → cwd (today's behavior); provided → the caller's repo, even
    // when it's a subdir (git normalizes to the toplevel + strips symlinks).
    const wtPath = freeWorktreePath(join(WORKTREE_BASE, name));

    // A leftover branch of this name from an earlier run must not fail the
    // whole creation — reuse the name if merged, side-step it if not.
    const branch = resolveStaleBranchName(branchName, resolvedRoot);
    addWorktreeOnNewBranch(resolvedRoot, wtPath, branch);

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
