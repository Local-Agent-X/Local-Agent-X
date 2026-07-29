/**
 * Shared internals for the worktree modules: the git runner, the in-memory
 * registry of active worktrees, and the temp base path. Imported by every
 * sibling worktree module so they all read/write the SAME registry.
 */

import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLogger } from "../logger.js";
import { composeGitArgs } from "../git-safety.js";

export const logger = createLogger("agency.worktree");

export interface WorktreeEntry {
  path: string;
  branch: string;
  baseBranch: string;  // The branch we'll merge back to (captured at creation)
  repoRoot: string;
  runId?: string;
  mergedSuccessfully: boolean;
  /** Durable ownership fence. Optional only for legacy/test-seeded entries. */
  ownerToken?: string;
  ownerGeneration?: number;
  /** Recovered entries survive process shutdown until their operation resumes. */
  recovered?: boolean;
}

export const WORKTREE_BASE = join(tmpdir(), "lax-worktrees");
export const activeWorktrees = new Map<string, WorktreeEntry>();
/** Recovered work is quarantined here until its exact durable run resumes. */
export const pendingRecoveredWorktrees = new Map<string, WorktreeEntry>();

/**
 * Generous global cap on concurrent worktrees, as a cross-source safety
 * backstop: each worktree is a full repo copy, and the agent/self-edit/update/
 * autopilot paths all create them from different entry points with no single
 * combined limit. The default (12) only trips on a runaway — the legitimate
 * max is ~agent-lane-cap(5) + self-edit(1) + update(1) + autopilot headroom.
 */
export const MAX_CONCURRENT_WORKTREES = Number(process.env.LAX_MAX_WORKTREES) || 12;
export const MAX_PENDING_RECOVERED_WORKTREES = MAX_CONCURRENT_WORKTREES * 4;

/** True while there's room under the global cap to create another worktree. */
export function worktreeSlotAvailable(): boolean {
  return activeWorktrees.size < MAX_CONCURRENT_WORKTREES;
}

/**
 * Release a worktree's registry slot WITHOUT touching disk. For fail/held
 * paths that deliberately preserve the branch + directory for inspection
 * (uncommitted surgeon changes live only in the worktree dir): the entry
 * counts against MAX_CONCURRENT_WORKTREES, so leaking it on every failure
 * would brick all worktree creation after the cap's worth of failed runs.
 * No-op if the entry is already gone (e.g. cleanupWorktree ran).
 */
export function releaseWorktreeSlot(name: string): void {
  if (activeWorktrees.delete(name)) {
    logger.info(`[worktree] released registry slot for ${name} (branch + dir left on disk)`);
  }
}

/** Hard ceiling on a single git invocation, shared by both runners. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on buffered git output, per stream, for {@link gitAsync}.
 *
 * Sync git() is bounded by execFileSync's 1 MiB default maxBuffer — past it the
 * child is killed and the call throws ENOBUFS. The async twin must stay bounded
 * for the same reason (getMergeDeltaDiff asks for whole-branch diffs, so an
 * unbounded accumulator is a real memory risk on the largest-output call here),
 * just less meanly: 8 MiB admits real diffs the 1 MiB sync limit rejected.
 *
 * Over the cap this THROWS rather than keeping a bounded tail the way the build
 * runners do. Build output is prose a human reads; git output here is PARSED —
 * rev-parse SHAs, `status --porcelain` lines, the diff the refutation gate
 * scrutinizes. Silently truncating that would let a gate pass on content it
 * never saw, which is strictly worse than a loud failure the callers already
 * handle (getMergeDeltaDiff fails open; the rest propagate).
 */
export const GIT_OUTPUT_CAP = 8 * 1024 * 1024;

/** The one place a string command is split into argv, for both runners. */
function toArgv(args: string[] | string): string[] {
  return Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
}

/**
 * Run git with an explicit args array via execFileSync (no shell).
 *
 * The previous implementation used `execSync(\`git ${cmd}\`)` which spawns
 * through cmd.exe on Windows and intermittently failed with
 * `spawnSync C:\\WINDOWS\\system32\\cmd.exe ENOENT` when the inherited
 * environment was missing ComSpec / SystemRoot. execFileSync calls git
 * directly with explicit env passthrough — no shell, no env-dependent
 * lookup, no quoting concerns.
 *
 * `cwd` is REQUIRED and must name the intended repo/worktree. It used to
 * default to `process.cwd()`, which — when the app runs from a user's live dev
 * checkout — silently pointed repo-global mutations (worktree prune, branch
 * delete) at that checkout instead of the app's own %TEMP% worktree base,
 * destroying it. Every call site now names its target explicitly; a caller that
 * genuinely wants the ambient repo passes `process.cwd()` on purpose.
 */
export function git(args: string[] | string, cwd: string): string {
  const argv = toArgv(args);
  try {
    return execFileSync("git", composeGitArgs(argv), {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: process.env,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${argv.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

/**
 * Async twin of {@link git} — same argv, same safety flags, same 30s ceiling,
 * same `git <cmd> failed: <stderr>` rejection, but it awaits the child instead
 * of parking the event loop for its whole lifetime.
 *
 * The sync form runs many invocations back to back (status → rev-parse → diff
 * → …) with nothing between them, so the server stops answering for the sum of
 * every git call in the sequence. The merge-delta readers (files, diff, base
 * info) run on this; {@link git} stays for the worktree modules that are still
 * synchronous — lifecycle, junctions, boot-sweep, recovery, and the
 * worktree-state readers whose callers cannot yet await.
 */
export function gitAsync(args: string[] | string, cwd: string): Promise<string> {
  const argv = toArgv(args);
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", composeGitArgs(argv), {
      cwd,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    const fail = (detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectGit(new Error(`git ${argv.join(" ")} failed: ${detail}`));
    };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
    // setEncoding decodes ACROSS chunk boundaries — a multi-byte character split
    // by a 64 KiB pipe read is held until its remaining bytes arrive. Appending
    // Buffers instead (`stdout += chunk`) decodes each half on its own and turns
    // the character into U+FFFD, corrupting output the callers go on to parse.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Same shape as the timeout above: flag, kill, and let the exit handler do
    // the failing — so the promise settles only once the child is reaped and
    // has let go of the repo's handles, never while it is still dying.
    const overflow = () => { overflowed = true; child.kill("SIGKILL"); };
    child.stdout.on("data", (chunk: string) => {
      if (overflowed) return;
      stdout += chunk;
      if (stdout.length > GIT_OUTPUT_CAP) overflow();
    });
    child.stderr.on("data", (chunk: string) => {
      if (overflowed) return;
      stderr += chunk;
      if (stderr.length > GIT_OUTPUT_CAP) overflow();
    });
    child.once("error", (e: Error) => fail(e.message));
    child.once("exit", (code) => {
      if (overflowed) return fail(`output exceeded the ${GIT_OUTPUT_CAP / (1024 * 1024)} MiB cap`);
      if (timedOut) return fail(`timed out after ${GIT_TIMEOUT_MS}ms`);
      if (code !== 0) return fail(stderr || `exited with code ${code}`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveGit(stdout.trim());
    });
  });
}
