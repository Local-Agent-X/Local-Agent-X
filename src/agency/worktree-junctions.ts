/**
 * node_modules junction management + the boot-time orphan sweep.
 *
 * Junctions (Windows) / symlinks (Unix) share the parent repo's node_modules
 * and dist into a worktree so autopilot builds resolve deps without a per-shift
 * npm install. The hazard is that a force-recursive delete can traverse INTO a
 * live reparse point and delete the TARGET's contents (the parent's real
 * node_modules), so every destructive path unlinks reparse points FIRST.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, lstatSync, unlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { isSelfEditLockHeldByLiveProcess } from "../self-edit/global-lock.js";
import { git, logger, WORKTREE_BASE } from "./worktree-core.js";

/**
 * Junction (Windows) or symlink (Unix) a directory from src into dst.
 * Used to share node_modules + dist between the parent repo and the worktree
 * so autopilot doesn't need to npm-install per shift.
 */
export function linkDirectoryInto(srcAbs: string, dstAbs: string): void {
  if (!existsSync(srcAbs)) return;       // nothing to link
  if (existsSync(dstAbs)) return;        // already there (e.g. tracked dist)
  try {
    if (process.platform === "win32") {
      // Junction works without admin and is transparent to most tooling.
      execSync(`cmd /c mklink /J "${dstAbs}" "${srcAbs}"`, { encoding: "utf-8", timeout: 10_000, windowsHide: true });
    } else {
      symlinkSync(srcAbs, dstAbs, "dir");
    }
  } catch (e) {
    logger.warn(`[worktree] Failed to link ${srcAbs} -> ${dstAbs}: ${(e as Error).message}`);
  }
}

/**
 * Remove every node_modules junction we linked into a worktree, BEFORE any
 * destructive teardown (`git worktree remove --force`).
 *
 * linkDirectoryInto() junctions the parent repo's real node_modules into the
 * worktree so builds resolve deps without a per-shift npm install. A junction
 * is a reparse point; a force-recursive directory delete can traverse INTO it
 * and delete the TARGET's contents — i.e. the parent's real node_modules,
 * taking @esbuild/arikernel with it and bricking the app. Unlinking the
 * junction first removes the only thing that can be traversed.
 *
 * Returns the links it could NOT remove. A non-empty return means teardown
 * must refuse the destructive delete — the junction is still live and would be
 * traversed.
 */
/**
 * Unlink a single junction/symlink reparse point WITHOUT following it. A real
 * (non-link) entry or a missing path is left alone and counts as success — we
 * only ever remove reparse points, never real directories. On Windows `rmdir`
 * (no /S) removes ONLY the reparse point; if the target were a real non-empty
 * dir it fails safely without traversing in. Returns true if the link is gone
 * (removed / absent / not-a-link), false if it could not be unlinked.
 */
function unlinkReparsePoint(link: string): boolean {
  let st;
  try { st = lstatSync(link); } catch { return true; } // not present
  if (!st.isSymbolicLink()) return true;               // real entry — not ours, never delete
  try {
    if (process.platform === "win32") execSync(`cmd /c rmdir "${link}"`, { timeout: 10_000, windowsHide: true });
    else unlinkSync(link);
    return true;
  } catch (e) {
    logger.warn(`[worktree] Failed to unlink reparse point ${link}: ${(e as Error).message}`);
    return false;
  }
}

export function unlinkSharedJunctions(wtPath: string): string[] {
  const candidates = [join(wtPath, "node_modules")];
  const pkgsDir = join(wtPath, "packages");
  if (existsSync(pkgsDir)) {
    for (const pkg of readdirSync(pkgsDir)) candidates.push(join(pkgsDir, pkg, "node_modules"));
  }
  return candidates.filter(link => !unlinkReparsePoint(link));
}

/**
 * Find every junction/symlink at the shallow locations where a worktree
 * junction could live: the worktree's direct children and one level under
 * packages/. Junctions are always created shallow (node_modules, packages/<pkg>/
 * node_modules, and any future one like dist), so this catches them all without
 * walking the entire source tree. Used by the boot sweep so a raw recursive
 * delete can never traverse a reparse point this helper missed.
 */
/**
 * Recursive-delete a directory, retrying on Windows transient lock errors.
 *
 * On Windows a just-released worktree dir is often still pinned for a few
 * hundred ms by an AV scanner, the file indexer, or git's own handle teardown,
 * surfacing as EBUSY / EPERM / ENOTEMPTY. The old single-shot rmSync logged and
 * gave up, so the orphan survived every boot and accumulated forever. A short
 * backoff lets the OS release the handle. ENOENT (already gone) is success.
 */
async function rmDirWithRetry(dir: string, attempts = 5): Promise<boolean> {
  const transient = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
  for (let i = 0; i < attempts; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (!code || !transient.has(code) || i === attempts - 1) {
        logger.warn(`[worktree] rm ${dir} failed (${code}): ${(e as Error).message}`);
        return false;
      }
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
  return false;
}

function scanReparsePoints(wtPath: string): string[] {
  const found: string[] = [];
  const scanDir = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try { if (lstatSync(p).isSymbolicLink()) found.push(p); } catch { /* skip unreadable */ }
    }
  };
  scanDir(wtPath);
  const pkgsDir = join(wtPath, "packages");
  if (existsSync(pkgsDir)) {
    try { for (const pkg of readdirSync(pkgsDir)) scanDir(join(pkgsDir, pkg)); } catch { /* skip */ }
  }
  return found;
}

/**
 * After the orphan sweep, delete leftover agent branches (selfedit/<slug>/<ts>,
 * autopilot/<slug>/<ts>) that are FULLY MERGED into the current base and not
 * checked out in any worktree. A successful self_edit merge already deletes its
 * own branch; this catches the autopilot human-merge flow, where the user merges
 * the branch by hand and nothing in the app ever cleans up the dead ref.
 *
 * Merged-ONLY, deliberately narrower than "merged OR worktree-gone": a
 * held-for-review or gate-failed self_edit preserves its UNMERGED branch on
 * purpose (the user is told to `git diff`/`git merge` it) while the sweep above
 * removes that branch's worktree — so "worktree is gone" does NOT mean the work
 * is abandoned. `git branch -d` (lower-case) refuses to delete an unmerged
 * branch, so even a misclassified branch can't lose work.
 */
function pruneMergedAgentBranches(): void {
  const checkedOut = new Set<string>();
  try {
    for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("branch ")) checkedOut.add(line.slice(7).replace(/^refs\/heads\//, ""));
    }
  } catch { return; }

  let branches: string[];
  try {
    branches = git(["branch", "--merged"]).split("\n")
      .map(l => l.replace(/^[*+]\s*/, "").trim())
      .filter(Boolean);
  } catch { return; }

  let deleted = 0;
  for (const b of branches) {
    if (!(b.startsWith("selfedit/") || b.startsWith("autopilot/")) || checkedOut.has(b)) continue;
    try { git(["branch", "-d", b]); deleted++; }
    catch { /* unmerged or still in use — leave it */ }
  }
  if (deleted) logger.info(`[worktree] orphan sweep: deleted ${deleted} merged agent branch(es)`);
}

/**
 * Boot-time sweep of orphaned worktrees left in %TEMP%/lax-worktrees by a
 * self_edit / autopilot run that crashed between worktree-create and cleanup.
 *
 * Each orphan can still hold a LIVE junction (node_modules, packages/<pkg>/
 * node_modules, or any future shallow link) pointing at the parent repo's real
 * tree. A later `git worktree prune`, AV scan, or manual %TEMP% cleanup can
 * traverse that junction and delete the parent's real files — bricking the app
 * (#11). We scan for EVERY shallow reparse point and unlink it first (not just
 * the hardcoded node_modules paths), THEN remove the now-link-free orphan dir,
 * THEN prune git's stale registry. An orphan with any reparse point we could
 * NOT unlink is left untouched and logged — never deleted, since deleting it is
 * exactly the traversal we're guarding against.
 *
 * Safe to call at boot: the in-memory worktree registry is empty in a fresh
 * process, so everything on disk under WORKTREE_BASE is by definition an orphan
 * from a prior run.
 */
export async function sweepOrphanWorktreeJunctions(): Promise<void> {
  // A live self_edit holds the global lock while it builds inside a worktree
  // under WORKTREE_BASE. During a restart overlap (old instance mid-self_edit,
  // new instance booting) that worktree is NOT an orphan — unlinking its
  // junction would brick the in-flight build. Skip the whole sweep; the next
  // boot (no active self_edit) reclaims any genuine orphans.
  if (isSelfEditLockHeldByLiveProcess()) {
    logger.info("[worktree] orphan sweep: a live self_edit holds the global lock — skipping to protect its active worktree");
    return;
  }
  if (!existsSync(WORKTREE_BASE)) return;
  let dirs: string[];
  try {
    dirs = readdirSync(WORKTREE_BASE);
  } catch (e) {
    logger.warn(`[worktree] orphan sweep: cannot read ${WORKTREE_BASE}: ${(e as Error).message}`);
    return;
  }
  if (dirs.length === 0) return;

  let removed = 0;
  let stuckTotal = 0;
  for (const name of dirs) {
    const wtPath = join(WORKTREE_BASE, name);
    try { if (!lstatSync(wtPath).isDirectory()) continue; } catch { continue; }

    // Unlink EVERY shallow reparse point, not just the node_modules ones — an
    // unknown/future junction (e.g. a dist link) must not survive into the
    // recursive delete below and get traversed into the parent's real tree.
    const points = scanReparsePoints(wtPath);
    const stuck = points.filter(p => !unlinkReparsePoint(p));
    // Belt-and-suspenders: re-scan. If ANY reparse point remains, refuse to
    // recursive-delete this orphan — deletion would traverse the live link.
    const remaining = scanReparsePoints(wtPath);
    if (stuck.length || remaining.length) {
      stuckTotal += Math.max(stuck.length, remaining.length);
      logger.warn(`[worktree] orphan sweep: live reparse point(s) in ${wtPath} (${[...new Set([...stuck, ...remaining])].join(", ")}) — left on disk to protect the parent tree`);
      continue;
    }
    // Reparse-point-free now — safe to remove the orphan dir entirely. Retry
    // on Windows transient locks (AV / indexer / git handle) rather than
    // letting the orphan survive to the next boot.
    if (await rmDirWithRetry(wtPath)) removed++;
  }

  // Prune git's registry of the worktrees we just removed. Run AFTER unlinking
  // so prune can never traverse a live junction.
  try { git(["worktree", "prune"]); }
  catch (e) { logger.warn(`[worktree] orphan sweep: git worktree prune failed: ${(e as Error).message}`); }

  // Now that the registry is pruned, drop dead agent branches (merged-only).
  pruneMergedAgentBranches();

  logger.info(`[worktree] orphan sweep: ${dirs.length} dir(s) scanned, ${removed} removed, ${stuckTotal} junction(s) stuck`);
}
