/**
 * node_modules junction management + reparse-safe teardown helpers.
 *
 * The boot-time orphan sweep itself lives in worktree-recovery.ts
 * (reconcileWorktreeBase); this module owns the junction primitives it and the
 * lifecycle teardown rely on (unlink reparse points, prune merged agent
 * branches).
 *
 * Junctions (Windows) / symlinks (Unix) share the parent repo's node_modules
 * and dist into a worktree so autopilot builds resolve deps without a per-shift
 * npm install. The hazard is that a force-recursive delete can traverse INTO a
 * live reparse point and delete the TARGET's contents (the parent's real
 * node_modules), so every destructive path unlinks reparse points FIRST.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, lstatSync, realpathSync, unlinkSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { git, logger } from "./worktree-core.js";

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

/**
 * True if `nmPath` exists and realpath-resolves OUTSIDE `sandboxRoot` — i.e. a
 * junction/symlink is still bridging the sandbox's node_modules into the
 * parent's real tree. A recursive delete (`rm -rf`, `git worktree remove`) or
 * `npm ci`'s clean step over such a path traverses the link and destroys the
 * parent — the loaded native modules of a running install (sqlite-vec's
 * vec0.dll) — which Windows then refuses with EPERM after a partial wipe.
 *
 * realpath FOLLOWS the reparse point regardless of how lstat classifies it, so
 * a junction that lstat misreads as a plain directory (the Windows quirk that
 * let the live install get wiped) is still caught here. This is the proof that
 * unlinkReparsePoint actually removed the link, rather than trusting its return.
 */
export function escapesSandbox(nmPath: string, sandboxRoot: string): boolean {
  let target: string;
  try { target = resolve(realpathSync(nmPath)); } catch { return false; } // absent → nothing to traverse
  let root: string;
  try { root = resolve(realpathSync(sandboxRoot)); } catch { root = resolve(sandboxRoot); }
  return target !== root && !target.startsWith(root + sep);
}

/** The shallow node_modules locations a worktree junction can live at: the
 *  worktree root and one level under packages/. Junctions are always created
 *  shallow, so this is the full set without walking the tree. */
function shallowNodeModules(wtPath: string): string[] {
  const out = [join(wtPath, "node_modules")];
  const pkgsDir = join(wtPath, "packages");
  if (existsSync(pkgsDir)) {
    for (const pkg of readdirSync(pkgsDir)) out.push(join(pkgsDir, pkg, "node_modules"));
  }
  return out;
}

export function unlinkSharedJunctions(wtPath: string): string[] {
  return shallowNodeModules(wtPath).filter(link => {
    unlinkReparsePoint(link);
    // Trust the realpath, not unlinkReparsePoint's return: a junction that
    // survived the unlink (a no-op rmdir, or one lstat misclassified as a real
    // dir) still resolves into the parent tree. Report it as stuck so callers
    // refuse the destructive delete that would traverse it.
    return escapesSandbox(link, wtPath);
  });
}

/**
 * Find every junction/symlink at the shallow locations where a worktree
 * junction could live: the worktree's direct children and one level under
 * packages/. Junctions are always created shallow (node_modules, packages/<pkg>/
 * node_modules, and any future one like dist), so this catches them all without
 * walking the entire source tree. Used by the boot sweep so a raw recursive
 * delete can never traverse a reparse point this helper missed.
 */
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

/** Unlink every shallow reparse point before boot recovery removes a worktree. */
export function unlinkAllShallowReparsePoints(wtPath: string): string[] {
  const points = scanReparsePoints(wtPath);
  const stuck = points.filter(path => !unlinkReparsePoint(path));
  const remaining = scanReparsePoints(wtPath);
  const escaped = shallowNodeModules(wtPath).filter(path => escapesSandbox(path, wtPath));
  return [...new Set([...stuck, ...remaining, ...escaped])];
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
export function pruneMergedAgentBranches(repoRoot: string): void {
  const checkedOut = new Set<string>();
  try {
    for (const line of git(["worktree", "list", "--porcelain"], repoRoot).split("\n")) {
      if (line.startsWith("branch ")) checkedOut.add(line.slice(7).replace(/^refs\/heads\//, ""));
    }
  } catch { return; }

  let branches: string[];
  try {
    branches = git(["branch", "--merged"], repoRoot).split("\n")
      .map(l => l.replace(/^[*+]\s*/, "").trim())
      .filter(Boolean);
  } catch { return; }

  let deleted = 0;
  for (const b of branches) {
    if (!(b.startsWith("selfedit/") || b.startsWith("autopilot/")) || checkedOut.has(b)) continue;
    try { git(["branch", "-d", b], repoRoot); deleted++; }
    catch { /* unmerged or still in use — leave it */ }
  }
  if (deleted) logger.info(`[worktree] orphan sweep: deleted ${deleted} merged agent branch(es)`);
}
