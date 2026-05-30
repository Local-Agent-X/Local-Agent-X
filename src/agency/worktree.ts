/**
 * Git Worktree Manager — creates isolated filesystem copies for agents.
 *
 * Flow:
 *   1. createWorktree(agentId) → creates branch + worktree in /tmp
 *   2. Agent runs with cwd override pointing to worktree
 *   3. mergeWorktree(agentId) → commits changes, merges back to stored base branch
 *   4. cleanupWorktree(agentId) → removes worktree + temp branch (preserves branch on conflict)
 */

import { execSync, execFileSync } from "node:child_process";
import { existsSync, symlinkSync, readdirSync, statSync, lstatSync, unlinkSync, rmSync } from "node:fs";
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

const WORKTREE_BASE = join(tmpdir(), "lax-worktrees");
const activeWorktrees = new Map<string, WorktreeEntry>();

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
function git(args: string[] | string, cwd?: string): string {
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
    if (!status) {
      wt.mergedSuccessfully = true;
      cleanupWorktree(agentId);
      return { merged: true, files: 0 };
    }

    git("add -A", wt.path);
    const fileCount = git("diff --cached --numstat", wt.path).split("\n").filter(Boolean).length;
    git(["commit", "-m", `Agent ${agentId}: automated changes`], wt.path);

    // Merge into the base branch that was current when the worktree was created
    try {
      git(["checkout", wt.baseBranch], wt.repoRoot);
      git(["merge", wt.branch, "--no-edit"], wt.repoRoot);
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

/** Get worktree path for an agent */
export function getWorktreePath(agentId: string): string | undefined {
  return activeWorktrees.get(agentId)?.path;
}

/** Get the base branch a worktree was created from. Used by autopilot summary. */
export function getWorktreeBaseBranch(name: string): string | undefined {
  return activeWorktrees.get(name)?.baseBranch;
}

/** Get the branch name of a worktree. */
export function getWorktreeBranch(name: string): string | undefined {
  return activeWorktrees.get(name)?.branch;
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
 * Junction (Windows) or symlink (Unix) a directory from src into dst.
 * Used to share node_modules + dist between the parent repo and the worktree
 * so autopilot doesn't need to npm-install per shift.
 */
function linkDirectoryInto(srcAbs: string, dstAbs: string): void {
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

function unlinkSharedJunctions(wtPath: string): string[] {
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
export function sweepOrphanWorktreeJunctions(): void {
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
    // Reparse-point-free now — safe to remove the orphan dir entirely.
    try { rmSync(wtPath, { recursive: true, force: true }); removed++; }
    catch (e) { logger.warn(`[worktree] orphan sweep: failed to remove ${wtPath}: ${(e as Error).message}`); }
  }

  // Prune git's registry of the worktrees we just removed. Run AFTER unlinking
  // so prune can never traverse a live junction.
  try { git(["worktree", "prune"]); }
  catch (e) { logger.warn(`[worktree] orphan sweep: git worktree prune failed: ${(e as Error).message}`); }

  logger.info(`[worktree] orphan sweep: ${dirs.length} dir(s) scanned, ${removed} removed, ${stuckTotal} junction(s) stuck`);
}

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

/** Worktree-scoped git status --porcelain. Returns empty string for clean. */
export function getWorktreeStatus(name: string): string {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  return git("status --porcelain", wt.path);
}

/**
 * True if any changed file is a dependency manifest (root or nested package).
 *
 * A self_edit that touches package.json / package-lock.json changes what
 * `npm ci` installs, so it must trigger an isolated real install instead of
 * letting the write pass through the shared node_modules junction into the
 * parent repo. Matches on basename so nested workspace manifests
 * (e.g. packages/arikernel/package.json) count too.
 */
export function changedFilesTouchDeps(files: string[]): boolean {
  return files.some(f => {
    const base = f.split(/[\\/]/).pop() ?? f;
    return base === "package.json" || base === "package-lock.json";
  });
}

/**
 * Of the given changed files, return those touching security-sensitive paths:
 * src/security/**, src/tool-policy/**, src/auth/**, and config/protected-files.json.
 * A self_edit that rewrites these can silently weaken the layer that authorizes
 * every tool call — and a weakened layer still builds, boots, and chats, so the
 * sandbox gates can't catch it. The sandbox holds these for explicit human
 * review instead of auto-merging. Backslashes are normalized so Windows paths
 * from `git status` match.
 */
export function securitySensitiveChangedFiles(files: string[]): string[] {
  return files.filter(f => {
    const p = f.replace(/\\/g, "/");
    return p.startsWith("src/security/")
      || p.startsWith("src/tool-policy/")
      || p.startsWith("src/auth/")
      || p === "config/protected-files.json";
  });
}

/**
 * Drop the worktree's shared node_modules junction so a real isolated install
 * can replace it. Used by the deps gate when a self_edit changes dependencies:
 * installing through the junction would write into the parent repo's real
 * node_modules. Removing the junction first makes the subsequent `npm ci`
 * (run by the gate via runCommandInWorktree) populate a real isolated dir.
 *
 * Does NOT run npm — the install lives next to the other gates.
 */
export function isolateNodeModules(name: string): { ok: boolean; detail: string } {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  const stuck = unlinkSharedJunctions(wt.path);
  if (stuck.length) {
    return { ok: false, detail: `could not unlink junction(s): ${stuck.join(", ")}` };
  }
  return { ok: true, detail: "junction dropped; ready for isolated install" };
}

/** List of files changed (added/modified/deleted) in the worktree's uncommitted state. */
export function getWorktreeChangedFiles(name: string): string[] {
  const status = getWorktreeStatus(name);
  if (!status) return [];
  return status.split("\n")
    .filter(Boolean)
    .map(line => line.slice(3).trim()) // strip 2-char status + space
    .filter(Boolean);
}

/** Hard reset uncommitted changes in worktree. */
export function resetWorktree(name: string): void {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  git("reset --hard HEAD", wt.path);
  git("clean -fd", wt.path);
  logger.info(`[worktree] Reset ${name} to HEAD`);
}

/** Stage everything and commit. Returns commit SHA, or null if nothing to commit. */
export function commitInWorktree(name: string, message: string): string | null {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  const status = git(["status", "--porcelain"], wt.path);
  if (!status) return null;
  git(["add", "-A"], wt.path);
  // No shell escaping needed — execFileSync passes the arg as a single argv
  // entry. Newlines kept compact for tidy commit subjects.
  const compactMessage = message.replace(/\r\n/g, "\n");
  git(["commit", "-m", compactMessage], wt.path);
  return git(["rev-parse", "HEAD"], wt.path);
}

interface BuildOptions {
  command: string;
  timeoutMs: number;
  /** Env for the command. Defaults to the parent process env. Callers running
   *  worktree code authored by an untrusted self_edit child pass a scrubbed env
   *  so the command can't read+exfil the server's credentials. */
  env?: NodeJS.ProcessEnv;
}

interface BuildResult {
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Capture the merge base info BEFORE mergeWorktree deletes the registry entry.
 *
 * Returns the repoRoot, baseBranch, and the base branch HEAD sha as it stands
 * RIGHT NOW (pre-merge). The caller stashes this so a post-merge re-gate failure
 * can hard-reset the base branch back to where it was before the merge.
 */
export function getMergeBaseInfo(
  name: string,
): { repoRoot: string; baseBranch: string; sha: string } | null {
  const wt = activeWorktrees.get(name);
  if (!wt) return null;
  return {
    repoRoot: wt.repoRoot,
    baseBranch: wt.baseBranch,
    sha: git(["rev-parse", wt.baseBranch], wt.repoRoot),
  };
}

/** Resolve a branch's current HEAD sha in the given repo. */
export function getBranchHead(repoRoot: string, branch: string): string {
  return git(["rev-parse", branch], repoRoot);
}

/** Hard-reset a base branch back to a known sha (used to revert a bad merge). */
export function revertBranchTo(
  repoRoot: string,
  baseBranch: string,
  sha: string,
): { ok: boolean; detail: string } {
  try {
    git(["checkout", baseBranch], repoRoot);
    git(["reset", "--hard", sha], repoRoot);
    return { ok: true, detail: `reset ${baseBranch} to ${sha.slice(0, 8)}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Run `npm run build` in the repo root (NOT a worktree). Used to re-validate the
 * merged main tree after a self_edit merge, since the merge can combine the
 * worktree branch with main commits no gate ever saw.
 */
export function runRepoBuild(repoRoot: string, timeoutMs: number): { ok: boolean; detail: string } {
  try {
    execSync("npm run build", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, detail: "build passed" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, detail: (err.stderr || err.stdout || err.message).slice(-1500) };
  }
}

/** Run a build/test command inside the worktree. */
export function runCommandInWorktree(name: string, opts: BuildOptions): BuildResult {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  const start = Date.now();
  try {
    const stdout = execSync(opts.command, {
      cwd: wt.path,
      encoding: "utf-8",
      timeout: opts.timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { ok: true, durationMs: Date.now() - start, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string; code?: number };
    return {
      ok: false,
      durationMs: Date.now() - start,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  }
}
