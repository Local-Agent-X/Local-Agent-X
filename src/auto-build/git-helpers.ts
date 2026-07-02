/**
 * Thin git wrappers for the auto-build loop.
 *
 * Scope is intentionally narrow: read HEAD sha, capture diff against a
 * sha, stage specific paths, create a commit with a message. No branch
 * management, no remotes — the loop expects to run inside a git repo
 * already on the working branch the user wants.
 *
 * All functions are pure-ish wrappers around `git` subprocess calls
 * scoped to `cwd`. Failures bubble up as rejected promises with the
 * stderr text — the loop logs them as halts.
 */

import { spawn } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  /** Default 30s — git ops are fast; long delays are usually pathological. */
  timeoutMs?: number;
}

interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function gitRun(args: string[], opts: GitRunOptions, stdin?: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch { /* already dead */ } }, opts.timeoutMs ?? 30_000);
    const proc = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    proc.stdout?.on("data", c => stdout += c.toString());
    proc.stderr?.on("data", c => stderr += c.toString());
    proc.on("error", e => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: stderr || e.message }); });
    proc.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }); });
    if (stdin !== undefined) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }
  });
}

export async function getHeadSha(cwd: string): Promise<string> {
  const r = await gitRun(["rev-parse", "HEAD"], { cwd });
  if (r.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export interface GitBaseline {
  sha: string;
  /** True when this call ran `git init` (dir wasn't a repo). */
  initialized: boolean;
  /** True when this call created the baseline commit (repo had no HEAD). */
  committed: boolean;
}

/**
 * Establish the git baseline the loop's rollback/diff machinery requires.
 * The loop can't assume its precondition into existence — nothing upstream
 * (build_app, finalize_app_build, a hand-made dir) guarantees a repo, and
 * without one every fresh project halts before chunk 1.
 *
 * Three states handled: not a repo → init + commit-all; repo with no HEAD
 * (fresh init) → commit-all; repo with HEAD → no-op. A dir nested inside a
 * larger repo counts as "has HEAD" — same contract as before: chunks commit
 * to whatever repo contains the project.
 */
export async function ensureGitBaseline(cwd: string): Promise<GitBaseline> {
  const inside = await gitRun(["rev-parse", "--is-inside-work-tree"], { cwd });
  let initialized = false;
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    const init = await gitRun(["init"], { cwd });
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
    initialized = true;
  }

  const head = await gitRun(["rev-parse", "HEAD"], { cwd });
  if (head.exitCode === 0) return { sha: head.stdout.trim(), initialized, committed: false };

  const add = await gitRun(["add", "-A"], { cwd });
  if (add.exitCode !== 0) throw new Error(`git add -A failed: ${add.stderr.trim()}`);

  // Message via stdin (-F -) like gitCommit: gitRun spawns through a shell
  // on Windows, where an arg with spaces would split. --allow-empty: an
  // empty dir still gets a baseline sha to roll back to.
  const commitArgs = ["commit", "--allow-empty", "-F", "-"];
  const message = "chore: baseline before auto-build";
  let commit = await gitRun(commitArgs, { cwd }, message);
  if (commit.exitCode !== 0 && /user\.(name|email)|tell me who you are/i.test(commit.stderr + commit.stdout)) {
    // No git identity on this machine — the baseline commit is tooling
    // plumbing, not authorship, so a synthetic identity is fine here.
    commit = await gitRun(["-c", "user.name=lax-auto-build", "-c", "user.email=auto-build@localagentx.local", ...commitArgs], { cwd }, message);
  }
  if (commit.exitCode !== 0) throw new Error(`baseline commit failed: ${(commit.stderr || commit.stdout).trim()}`);

  return { sha: await getHeadSha(cwd), initialized, committed: true };
}

export async function gitDiffPath(cwd: string, sinceSha: string, pathSpec: string): Promise<string> {
  const r = await gitRun(["diff", "--no-color", sinceSha, "--", pathSpec], { cwd });
  if (r.exitCode !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function gitStatusPorcelain(cwd: string): Promise<string> {
  const r = await gitRun(["status", "--porcelain"], { cwd });
  if (r.exitCode !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function gitAdd(cwd: string, pathSpec: string): Promise<void> {
  const r = await gitRun(["add", "--", pathSpec], { cwd });
  if (r.exitCode !== 0) throw new Error(`git add ${pathSpec} failed: ${r.stderr.trim()}`);
}

/**
 * Commit with a message passed via stdin (-F -). Avoids escaping issues
 * for messages with quotes or newlines. Returns the new HEAD sha.
 *
 * Skips the commit entirely if nothing's staged — returns the existing
 * HEAD instead. This way the loop can safely call commit after a chunk
 * that turned out to be doc-only or whose changes were unstaged for
 * some reason; we don't error on "nothing to commit."
 */
export async function gitCommit(cwd: string, message: string): Promise<{ sha: string; committed: boolean }> {
  const status = await gitStatusPorcelain(cwd);
  const hasStaged = status.split(/\r?\n/).some(l => /^[MARCD]/.test(l));
  if (!hasStaged) {
    const sha = await getHeadSha(cwd);
    return { sha, committed: false };
  }
  const r = await gitRun(["commit", "-F", "-"], { cwd }, message);
  if (r.exitCode !== 0) throw new Error(`git commit failed: ${r.stderr.trim() || r.stdout.trim()}`);
  const sha = await getHeadSha(cwd);
  return { sha, committed: true };
}
