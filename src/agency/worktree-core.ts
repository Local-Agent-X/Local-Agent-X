/**
 * Shared internals for the worktree modules: the git runner, the in-memory
 * registry of active worktrees, and the temp base path. Imported by every
 * sibling worktree module so they all read/write the SAME registry.
 */

import { execFileSync } from "node:child_process";
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
  const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
  try {
    return execFileSync("git", composeGitArgs(argv), {
      cwd,
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
