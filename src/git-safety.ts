/**
 * Canonical git-safety layer — the ONE source of truth for the config flags the
 * app injects into every git invocation it makes against a real checkout.
 *
 * `gc.auto=0` disables Git's automatic garbage collection. Auto-gc is
 * default-enabled and fires opportunistically after object-creating commands
 * (fetch / merge / commit / stash); its repack+prune deletes objects it deems
 * unreachable. When any op momentarily severs a reachability root — a boot
 * `git worktree prune`, a `git branch -d`, a stash apply/drop — the very next
 * auto-gc can prune the now-transiently-unreachable objects from a SHARED
 * object store and corrupt the repo ("bad object HEAD"). Injecting the flag
 * per-invocation makes that cascade impossible without persisting any config
 * into the user's checkout.
 *
 * The app spawns git two ways, so this module offers both shapes and NOTHING
 * else should re-derive the flag list:
 *   composeGitArgs — argv arrays (execFileSync / spawn)
 *   gitSafeCmd     — shell command strings (execSync)
 *
 * and {@link gitExecutable}, the program the argv runners spawn, with
 * {@link execGitSync}, the one synchronous runner.
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { killOrphansOfSync } from "./process-tree-kill.js";

/** Config flags prepended to EVERY git invocation the app makes. */
export const GIT_SAFETY_ARGS: readonly string[] = ["-c", "gc.auto=0"];

/** Compose the full argv passed to git: safety flags first, then the command. */
export function composeGitArgs(args: string[] | string): string[] {
  const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
  return [...GIT_SAFETY_ARGS, ...argv];
}

/**
 * Prepend the safety flags to a `git ...` shell command so its fetch / merge /
 * commit / stash can never trigger auto-gc. Non-git commands (npm, etc.) pass
 * through unchanged.
 */
export function gitSafeCmd(cmd: string): string {
  return /^git\s/.test(cmd) ? cmd.replace(/^git\s/, `git ${GIT_SAFETY_ARGS.join(" ")} `) : cmd;
}

/**
 * The git a Git for Windows install runs for `git`, from the exec path that git
 * reports: `--exec-path` is <prefix>/libexec/git-core and the real git is
 * <prefix>/bin/git.exe, for a standard install and PortableGit alike, whatever
 * the prefix (mingw64, clangarm64). Null when that file is not there: a git
 * that is not Git for Windows' has no launcher in front of it.
 */
export function realGitBeside(execPath: string): string | null {
  const candidate = resolve(execPath, "..", "..", "bin", "git.exe");
  return statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : null;
}

let resolvedGit: string | undefined;

/**
 * The program the argv runners spawn: on Windows the git that does the work,
 * not Git for Windows' launcher.
 *
 * `git` on a Windows PATH is the launcher (<Git>\cmd\git.exe or
 * <Git>\bin\git.exe), which runs the real git as its own child. A runner that
 * kills its child (execFileSync on timeout or past maxBuffer) ended only the
 * launcher, and the real git ran on in the repo, holding the folder open.
 * Spawned directly, the child the runner kills is the git that is working.
 * Elsewhere, or when no real git is found, the name stays `git`.
 */
export function gitExecutable(): string {
  if (process.platform !== "win32") return "git";
  if (resolvedGit) return resolvedGit;
  let execPath: string;
  try {
    execPath = execFileSync("git", ["--exec-path"], { encoding: "utf-8", timeout: 10_000, windowsHide: true }).trim();
  } catch {
    return "git"; // not cached: a git installed later is found on the next call
  }
  resolvedGit = realGitBeside(execPath) ?? "git";
  return resolvedGit;
}

/**
 * The one synchronous git runner: execFileSync on {@link gitExecutable}, and
 * when the call's timeout or maxBuffer cuts it off, nothing git started is
 * left running. On Windows a hook's programs outlive the git that ran them
 * ({@link killOrphansOfSync}). The args are passed as given: compose them first.
 */
export function execGitSync(args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  const startedAt = Date.now();
  try {
    return execFileSync(gitExecutable(), args, options);
  } catch (e) {
    const err = e as { code?: string; pid?: number };
    if (err.pid && (err.code === "ETIMEDOUT" || err.code === "ENOBUFS")) killOrphansOfSync(err.pid, startedAt, Date.now());
    throw e;
  }
}
