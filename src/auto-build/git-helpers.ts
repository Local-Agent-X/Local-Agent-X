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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export interface GitRunOptions {
  cwd: string;
  /** Default 30s — most git ops are fast; index sweeps (add/commit) pass
   *  a bigger budget explicitly. */
  timeoutMs?: number;
}

interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the op was SIGTERM'd by our timeout — the error text must
   *  say so, not dump stderr (live failure: a timed-out `git add .` halted
   *  the build with 3.6MB of CRLF warnings as the "reason"). */
  timedOut: boolean;
}

// Index sweeps over a real project tree (npm install mid-chunk) can beat 30s
// on Windows with AV scanning in the way.
const SWEEP_TIMEOUT_MS = 180_000;

function gitRun(args: string[], opts: GitRunOptions, stdin?: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGTERM"); } catch { /* already dead */ } }, opts.timeoutMs ?? 30_000);
    const proc = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    proc.stdout?.on("data", c => stdout += c.toString());
    proc.stderr?.on("data", c => stderr += c.toString());
    proc.on("error", e => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: stderr || e.message, timedOut }); });
    proc.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, timedOut }); });
    if (stdin !== undefined) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }
  });
}

/**
 * Human-usable failure text for a git op: a timeout says "timed out"
 * instead of dumping whatever stderr accumulated, and normal failures
 * drop `warning:` noise (CRLF conversion spam on Windows) and cap length
 * so a halt reason stays a sentence, not a megabyte.
 */
export function gitFailText(op: string, r: GitRunResult, timeoutMs?: number): string {
  if (r.timedOut) {
    return `${op} timed out after ${Math.round((timeoutMs ?? 30_000) / 1000)}s — the index sweep may be too large (missing ignore rules?) or AV is throttling git`;
  }
  const meaningful = (r.stderr || r.stdout)
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("warning:"))
    .join("\n")
    .trim() || "(no error output)";
  return `${op} failed: ${meaningful.length > 1500 ? meaningful.slice(0, 1500) + " …[truncated]" : meaningful}`;
}

export async function getHeadSha(cwd: string): Promise<string> {
  const r = await gitRun(["rev-parse", "HEAD"], { cwd });
  if (r.exitCode !== 0) throw new Error(gitFailText("git rev-parse HEAD", r));
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
    if (init.exitCode !== 0) throw new Error(gitFailText("git init", init));
    initialized = true;
    writeStarterGitignore(cwd);
  }
  await ensureLoopExcludes(cwd);

  const head = await gitRun(["rev-parse", "HEAD"], { cwd });
  if (head.exitCode === 0) return { sha: head.stdout.trim(), initialized, committed: false };

  const add = await gitRun(["add", "-A"], { cwd, timeoutMs: SWEEP_TIMEOUT_MS });
  if (add.exitCode !== 0) throw new Error(gitFailText("git add -A", add, SWEEP_TIMEOUT_MS));

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
  if (commit.exitCode !== 0) throw new Error(gitFailText("baseline commit", commit));

  return { sha: await getHeadSha(cwd), initialized, committed: true };
}

// Junk the loop must never sweep into a chunk commit: dependency trees,
// framework build output, and the loop's own runtime state. Slow sweeps of
// node_modules are also what pushed `git add .` past its timeout.
const LOOP_EXCLUDES = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  "*.log",
  ".lax-build-run.json",
  ".lax-build-history.json",
  ".lax-preflight-*",
  ".primal-orchestrator-state.json",
  ".primal-build-state.json",
];
const EXCLUDE_MARKER = "# lax-auto-build excludes";

/** A fresh project gets a real .gitignore — correct default for something
 *  the user will eventually push. Never touches an existing file. */
function writeStarterGitignore(cwd: string): void {
  const p = join(cwd, ".gitignore");
  if (existsSync(p)) return;
  try {
    writeFileSync(p, LOOP_EXCLUDES.concat(".env", ".env.local", ".DS_Store").join("\n") + "\n");
  } catch { /* best-effort — the info/exclude block below still protects the loop */ }
}

/**
 * Idempotently add the loop's exclude patterns to `.git/info/exclude` —
 * repo-local, invisible to the working tree, and effective even when the
 * project pre-exists without a .gitignore (the live failure: chunk commits
 * swept node_modules/ + .next/ and `git add .` timed out). Only when the
 * project dir IS the repo toplevel — writing excludes into a PARENT repo's
 * info/exclude would ignore these patterns across someone else's tree.
 */
async function ensureLoopExcludes(cwd: string): Promise<void> {
  try {
    const top = await gitRun(["rev-parse", "--show-toplevel"], { cwd });
    if (top.exitCode !== 0) return;
    const gitDirR = await gitRun(["rev-parse", "--git-dir"], { cwd });
    if (gitDirR.exitCode !== 0) return;
    // Same dir check via git itself (spelling-proof): prefix is empty at toplevel.
    const prefix = await gitRun(["rev-parse", "--show-prefix"], { cwd });
    if (prefix.exitCode !== 0 || prefix.stdout.trim() !== "") return;

    const gitDirRaw = gitDirR.stdout.trim();
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(cwd, gitDirRaw);
    const excludePath = join(gitDir, "info", "exclude");
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    if (existing.includes(EXCLUDE_MARKER)) return;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(excludePath, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + EXCLUDE_MARKER + "\n" + LOOP_EXCLUDES.join("\n") + "\n");
  } catch { /* best-effort — a failed exclude write must not block the build */ }
}

export async function gitDiffPath(cwd: string, sinceSha: string, pathSpec: string): Promise<string> {
  const r = await gitRun(["diff", "--no-color", sinceSha, "--", pathSpec], { cwd });
  if (r.exitCode !== 0) throw new Error(gitFailText("git diff", r));
  return r.stdout;
}

export async function gitStatusPorcelain(cwd: string): Promise<string> {
  const r = await gitRun(["status", "--porcelain"], { cwd, timeoutMs: SWEEP_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(gitFailText("git status", r, SWEEP_TIMEOUT_MS));
  return r.stdout;
}

export async function gitAdd(cwd: string, pathSpec: string): Promise<void> {
  const r = await gitRun(["add", "--", pathSpec], { cwd, timeoutMs: SWEEP_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(gitFailText(`git add ${pathSpec}`, r, SWEEP_TIMEOUT_MS));
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
  const r = await gitRun(["commit", "-F", "-"], { cwd, timeoutMs: SWEEP_TIMEOUT_MS }, message);
  if (r.exitCode !== 0) throw new Error(gitFailText("git commit", r, SWEEP_TIMEOUT_MS));
  const sha = await getHeadSha(cwd);
  return { sha, committed: true };
}
