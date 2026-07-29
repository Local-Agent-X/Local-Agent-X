/**
 * Read/inspect and per-worktree mutation operations against the active-worktree
 * registry: path/branch getters, status + changed-file queries, change
 * classification, reset/commit/isolate, merge-base capture, and build runners.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import { activeWorktrees, git, gitAsync, logger } from "./worktree-core.js";
import { unlinkSharedJunctions } from "./worktree-junctions.js";
import { loadProtectedFiles } from "../config-loader.js";
import { killProcessTree } from "../process-tree-kill.js";

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
 * (run by the gate via runCommandInWorktreeAsync) populate a real isolated dir.
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

/** `git status --porcelain` text → changed-file list. The ONE parse, shared by
 *  the sync and async readers so they can't disagree about what changed. */
function parsePorcelain(status: string): string[] {
  if (!status) return [];
  return status.split("\n")
    .filter(Boolean)
    .map(line => line.slice(3).trim()) // strip 2-char status + space
    .filter(Boolean);
}

/** List of files changed (added/modified/deleted) in the worktree's uncommitted state. */
export function getWorktreeChangedFiles(name: string): string[] {
  return parsePorcelain(getWorktreeStatus(name));
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
export async function getMergeDeltaFiles(name: string): Promise<string[]> {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  const files = new Set<string>();
  // Committed delta: base branch tip → this worktree's branch head. The
  // three-dot range diffs against the merge base, so commits that landed on
  // the base since worktree creation don't show up as spurious changes.
  const base = await gitAsync(["rev-parse", wt.baseBranch], wt.repoRoot);
  const head = await gitAsync(["rev-parse", "HEAD"], wt.path);
  if (base !== head) {
    for (const f of (await gitAsync(["diff", "--name-only", `${base}...${head}`], wt.path)).split("\n")) {
      if (f.trim()) files.add(f.trim());
    }
  }
  // Uncommitted changes the merge step will `git add -A` and commit.
  for (const f of parsePorcelain(await gitAsync(["status", "--porcelain"], wt.path))) files.add(f);
  return [...files];
}

/**
 * The unified-diff TEXT of the merge delta — the same committed-plus-uncommitted
 * content getMergeDeltaFiles reports as a file list, but as the actual patch the
 * LLM refutation gate scrutinizes. Same base/range semantics: the committed
 * portion is `base...head` (diffed against the merge base) and the uncommitted
 * portion is the working-tree diff on top. Truncated to a sane cap so a giant
 * generated diff can't blow the classifier's context. Returns "" on ANY error —
 * the caller fails OPEN (a self_edit must not be blocked just because the diff
 * couldn't be read).
 */
const MERGE_DELTA_DIFF_CAP = 8000;
export async function getMergeDeltaDiff(name: string): Promise<string> {
  try {
    const wt = activeWorktrees.get(name);
    if (!wt) return "";
    let diff = "";
    // Committed delta: merge base → branch head (three-dot, mirrors the file list).
    const base = await gitAsync(["rev-parse", wt.baseBranch], wt.repoRoot);
    const head = await gitAsync(["rev-parse", "HEAD"], wt.path);
    if (base !== head) {
      diff += await gitAsync(["diff", `${base}...${head}`], wt.path);
    }
    // Uncommitted changes the merge step will `git add -A` and commit. Include
    // untracked files (--no-index would need pairing); `git diff HEAD` plus
    // `git diff` covers staged+unstaged against HEAD.
    const uncommitted = await gitAsync(["diff", "HEAD"], wt.path);
    if (uncommitted.trim()) {
      diff += (diff ? "\n" : "") + uncommitted;
    }
    if (diff.length > MERGE_DELTA_DIFF_CAP) {
      return diff.slice(0, MERGE_DELTA_DIFF_CAP) + "\n…[diff truncated]";
    }
    return diff;
  } catch {
    return "";
  }
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
export async function getMergeBaseInfo(
  name: string,
): Promise<{ repoRoot: string; baseBranch: string; sha: string } | null> {
  const wt = activeWorktrees.get(name);
  if (!wt) return null;
  return {
    repoRoot: wt.repoRoot,
    baseBranch: wt.baseBranch,
    sha: await gitAsync(["rev-parse", wt.baseBranch], wt.repoRoot),
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

/** Output retained per stream, inherited from the maxBuffer of the execSync
 *  twins this runner replaced. */
const RUNNER_OUTPUT_CAP = 10 * 1024 * 1024;

/**
 * Spawn `command` through a shell and AWAIT its exit.
 *
 * The execSync twins parked the whole event loop for the child's entire
 * lifetime, and these ceilings are minutes — so one repo build stopped the
 * server answering anything at all until it finished. Everything else matches
 * execSync: shell invocation, hidden window, the same per-stream output cap, and
 * a kill at `timeoutMs` through the shared tree-killer, which on Windows
 * taskkills the subtree BEFORE the cmd.exe wrapper so npm's grandchildren (tsc,
 * vite, a dev server) die with it instead of outliving the timeout. A non-zero
 * exit, a spawn error and a timeout all land as `ok: false` with the reason in
 * `stderr`.
 */
function runProcess(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<BuildResult> {
  const start = Date.now();
  return new Promise(resolveRun => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env ? { env: opts.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (ok: boolean, note: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ok, durationMs: Date.now() - start, stdout, stderr: stderr + note });
    };
    const timer = setTimeout(() => { timedOut = true; killProcessTree(child, "SIGKILL"); }, opts.timeoutMs);
    // setEncoding decodes across chunk boundaries; appending Buffers decodes
    // each 64 KiB read on its own and mangles any multi-byte character split
    // between two of them. Unlike gitAsync (whose output is parsed, so an
    // overflow must throw) a bounded TAIL is right here: this is build log
    // prose for a human, and the failure is always at the end of it.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { stdout = (stdout + c).slice(-RUNNER_OUTPUT_CAP); });
    child.stderr?.on("data", (c: string) => { stderr = (stderr + c).slice(-RUNNER_OUTPUT_CAP); });
    child.once("error", (e: Error) => finish(false, e.message));
    child.once("exit", code => finish(
      code === 0 && !timedOut,
      timedOut ? `command timed out after ${opts.timeoutMs}ms` : "",
    ));
  });
}

/**
 * Run `npm run build` in the repo root (NOT a worktree). Used to re-validate the
 * merged main tree after a self_edit merge, since the merge can combine the
 * worktree branch with main commits no gate ever saw.
 */
export async function runRepoBuildAsync(repoRoot: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const r = await runProcess("npm run build", { cwd: repoRoot, timeoutMs });
  return { ok: r.ok, detail: r.ok ? "build passed" : (r.stderr || r.stdout || "build failed (no output)").slice(-1500) };
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
export async function runDesktopTscBuildAsync(repoRoot: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const r = await runProcess("npx tsc --noEmitOnError", { cwd: join(repoRoot, "desktop"), timeoutMs });
  return { ok: r.ok, detail: r.ok ? "desktop tsc passed" : (r.stderr || r.stdout || "desktop tsc failed (no output)").slice(-1500) };
}

/** Run a build/test command inside the worktree. */
export async function runCommandInWorktreeAsync(name: string, opts: BuildOptions): Promise<BuildResult> {
  const wt = activeWorktrees.get(name);
  if (!wt) throw new Error(`No worktree found for ${name}`);
  return runProcess(opts.command, { cwd: wt.path, timeoutMs: opts.timeoutMs, env: opts.env });
}
