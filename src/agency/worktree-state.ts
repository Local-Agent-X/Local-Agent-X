/**
 * Read/inspect and per-worktree mutation operations against the active-worktree
 * registry: path/branch getters, status + changed-file queries, change
 * classification, reset/commit/isolate, merge-base capture, and build runners.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";

import { activeWorktrees, git, logger } from "./worktree-core.js";
import { unlinkSharedJunctions } from "./worktree-junctions.js";
import { loadProtectedFiles } from "../config-loader.js";

/**
 * True when `file` (a repo-relative path) is covered by a protected-files.json
 * entry. A trailing-slash entry matches the whole subtree; a plain entry is an
 * exact file match. Backslashes are normalized so Windows `git` paths match.
 */
function isProtectedPath(file: string, protectedEntries: string[]): boolean {
  const p = file.replace(/\\/g, "/");
  return protectedEntries.some(e => e.endsWith("/") ? p.startsWith(e) : p === e);
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
 * Of the given changed files, return those a self_edit merge must HOLD for
 * explicit human review — the engine-core + safety-layer set, derived from the
 * single source `config/protected-files.json` (the same manifest the edit/write
 * tools refuse). A self_edit that rewrites these can silently weaken the layer
 * that authorizes every tool call — OR the gate that's supposed to catch that —
 * and a weakened layer still builds, boots, and chats, so the build/bind/smoke
 * gates can't catch it. Deriving from the manifest (instead of a hardcoded
 * subset) means the held set can't drift below the protected set, and it now
 * covers the self-edit/worktree pipeline itself so the gate can't rewrite its
 * own gate and walk through.
 */
export function securitySensitiveChangedFiles(files: string[]): string[] {
  const protectedEntries = loadProtectedFiles();
  return files.filter(f => isProtectedPath(f, protectedEntries));
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

/**
 * The files that will actually land on the base branch if this worktree merges
 * NOW — the full merge delta, committed history included, plus any still-
 * uncommitted changes the merge step will auto-commit.
 *
 * This is the security boundary the gates must measure. getWorktreeChangedFiles
 * sees only `git status --porcelain` (uncommitted), so a surgeon that commits
 * its malicious diff and leaves a trivial uncommitted crumb passes a porcelain-
 * scoped gate while `mergeWorktree` still carries the committed change to main.
 * Measuring `baseSha...branchHead` (committed delta) ∪ uncommitted closes that
 * gap: nothing reaches the base branch without a gate having seen it.
 */
export function getMergeDeltaFiles(name: string): string[] {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  const files = new Set<string>();
  // Committed delta: base branch tip → this worktree's branch head. The
  // three-dot range diffs against the merge base, so commits that landed on
  // the base since worktree creation don't show up as spurious changes.
  const base = git(["rev-parse", wt.baseBranch], wt.repoRoot);
  const head = git(["rev-parse", "HEAD"], wt.path);
  if (base !== head) {
    for (const f of git(["diff", "--name-only", `${base}...${head}`], wt.path).split("\n")) {
      if (f.trim()) files.add(f.trim());
    }
  }
  // Uncommitted changes the merge step will `git add -A` and commit.
  for (const f of getWorktreeChangedFiles(name)) files.add(f);
  return [...files];
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

/**
 * Compile desktop/src → desktop/dist after a merged update, so the restart is a
 * single clean boot instead of reconcile rebuilding + relaunching. tsc only —
 * the native speech helper isn't a TS artifact and its sources don't change on
 * a desktop/src edit (full `npm run build` would re-run the native toolchain).
 * `--noEmitOnError`: a type error leaves the prior dist intact rather than a
 * half-written one, so a failure here degrades to reconcile's next-boot rebuild
 * instead of bricking the loaded main process.
 */
export function runDesktopTscBuild(repoRoot: string, timeoutMs: number): { ok: boolean; detail: string } {
  try {
    execSync("npx tsc --noEmitOnError", {
      cwd: join(repoRoot, "desktop"),
      encoding: "utf-8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, detail: "desktop tsc passed" };
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
