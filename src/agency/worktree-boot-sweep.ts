/**
 * Boot-sweep safety: reap ONLY the app's own %TEMP% worktrees, never a user's
 * live checkout.
 *
 * The boot orphan sweep (reconcileWorktreeBase) finishes with a REPO-GLOBAL
 * `git worktree prune` + a merged-agent-branch delete. That mutation used to run
 * with no cwd, defaulting to process.cwd() = whatever repo the app launched
 * from. On a developer's live checkout that de-registered the user's sibling
 * worktrees and — cascading into Git's default-enabled auto-gc — deleted the now
 * unreachable objects from the shared pack, corrupting the repo ("bad object
 * HEAD"). This module resolves the app's OWN repo explicitly and refuses the
 * repo-global mutation whenever that repo hosts any worktree outside
 * WORKTREE_BASE (the signature of a real working checkout, not a fresh install).
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { git, logger, WORKTREE_BASE } from "./worktree-core.js";
import { pruneMergedAgentBranches, unlinkAllShallowReparsePoints } from "./worktree-junctions.js";
import { removeWorktreeFolder } from "./worktree-leftovers.js";

/**
 * Case-normalized realpath, falling back to a plain resolve when the path is
 * absent (a prunable worktree whose dir is already gone). Both WORKTREE_BASE and
 * the candidate paths pass through here so separators + casing compare cleanly.
 */
function normalizePath(p: string): string {
  let value: string;
  try { value = realpathSync.native(p); } catch { value = resolve(p); }
  value = resolve(value);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Absolute paths of every worktree registered in `repoRoot`. */
function registeredWorktreePaths(repoRoot: string): string[] {
  const out: string[] = [];
  for (const line of git(["worktree", "list", "--porcelain"], repoRoot).split("\n")) {
    if (line.startsWith("worktree ")) out.push(line.slice("worktree ".length).trim());
  }
  return out;
}

/**
 * True when it is SAFE to run a repo-global mutation (worktree prune, merged
 * branch delete) against `repoRoot`: every linked worktree it has registered
 * lives under the app's own WORKTREE_BASE. A repoRoot that hosts ANY linked
 * worktree elsewhere is a user's live checkout (a dev tree with sibling
 * worktrees) — the exact thing the sweep must never prune. If git can't be
 * queried we refuse: any uncertainty errs toward NOT mutating the repo.
 */
export function bootSweepSafeForRepo(repoRoot: string): boolean {
  let paths: string[];
  try { paths = registeredWorktreePaths(repoRoot); }
  catch { return false; }
  const base = normalizePath(WORKTREE_BASE);
  const root = normalizePath(repoRoot);
  for (const p of paths) {
    const np = normalizePath(p);
    if (np === root) continue;                                   // the main worktree (the repo itself)
    if (np !== base && !np.startsWith(base + sep)) return false; // a foreign linked worktree
  }
  return true;
}

/** Resolve the repo the app itself runs from (its install / dev checkout). */
function resolveAppRepoRoot(): string | null {
  try { return git(["rev-parse", "--show-toplevel"], process.cwd()); }
  catch { return null; }
}

/**
 * Reap ONLY the app's own orphan worktrees: prune git's stale registry and drop
 * merged agent branches — but NEVER against a user's live checkout. Resolves the
 * app repo explicitly (no silent process.cwd() default in the git ops) and
 * refuses the repo-global mutation unless every linked worktree belongs to
 * WORKTREE_BASE.
 */
export function reapAppOwnWorktrees(repoRoot: string | null = resolveAppRepoRoot()): void {
  if (!repoRoot) return;
  if (!bootSweepSafeForRepo(repoRoot)) {
    logger.warn(`[worktree] boot sweep: ${repoRoot} hosts worktrees outside ${WORKTREE_BASE} (a live checkout) — skipping repo-global prune/branch cleanup to protect it`);
    return;
  }
  try { git(["worktree", "prune"], repoRoot); } catch { /* current repo unavailable */ }
  pruneMergedAgentBranches(repoRoot);
}

/**
 * Delete what is left of worktrees git has already removed. `git worktree
 * remove` drops the `.git` link first and then the files; on Windows a file a
 * just-killed process still held stops it there, and the folder stayed for
 * good: the recovery sweep reads a folder with no `.git` as "not a verifiable
 * git worktree" and leaves it. Five such folders held 2.4 GB of app copies and
 * node_modules in Temp on 2026-11-25. A folder that is still some program's
 * current directory is held for as long as that program runs: what a worker
 * left running there is ended first (worktree-leftovers.ts).
 *
 * A folder with a `.git` is a worktree, live or recoverable, and is the
 * recovery sweep's (reconcileWorktreeBase); one that is itself a link is never
 * followed. Junctions inside (a node_modules pointing at a parent's real
 * dependencies) are unlinked before the delete, and a folder holding one that
 * will not unlink is left alone, as cleanupWorktree does.
 */
export async function reapWorktreeRemnants(base = WORKTREE_BASE): Promise<string[]> {
  if (!existsSync(base)) return [];
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    const path = join(base, name);
    try { if (!lstatSync(path).isDirectory()) continue; } catch { continue; }
    if (existsSync(join(path, ".git"))) continue;
    const stuck = unlinkAllShallowReparsePoints(path);
    if (stuck.length) {
      logger.warn(`[worktree] leftover ${path} kept: a link inside would not unlink (${stuck.join(", ")})`);
      continue;
    }
    const gone = await removeWorktreeFolder(
      path,
      (reason) => logger.warn(`[worktree] leftover ${path} could not be deleted: ${reason}`),
      (line) => logger.info(`[worktree] ${line}`),
    );
    if (gone) removed.push(path);
  }
  if (removed.length) logger.info(`[worktree] deleted ${removed.length} leftover folder(s) of removed worktrees: ${removed.join(", ")}`);
  return removed;
}

