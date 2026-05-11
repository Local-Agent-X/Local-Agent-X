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
