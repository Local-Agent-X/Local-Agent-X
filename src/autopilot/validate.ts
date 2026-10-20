/**
 * Validate one autopilot round against its uncommitted worktree state.
 *
 * Order of gates (per plan):
 *   1. git status --porcelain → empty? → noop
 *   2. build command → fail? → revert + report error
 *   3. size delta check (the kit's rule, app-scaffold/kit-size.ts) → a changed
 *      file, or a function in one, pushed over its cap? → revert
 *   4. (opt-in) test command → fail? → revert
 *
 * On any fail, runs `git reset --hard HEAD && git clean -fd` so the next round
 * starts from the previous good commit (NOT HEAD~1 — there's no commit yet).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  getWorktreeStatus,
  getWorktreeChangedFiles,
  resetWorktree,
  runCommandInWorktreeAsync,
} from "../agency/worktree.js";
import { composeGitArgs, execGitSync } from "../git-safety.js";
import type { AutopilotConfig, RoundOutcome } from "./types.js";
import { KIT_LIMITS, overCapItems } from "../app-scaffold/kit-size.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.validate");

export interface ValidationResult {
  outcome: RoundOutcome;
  filesChanged: string[];
  /** Diagnostic detail for failure (build error, oversize file, etc.). Empty on pass/noop. */
  detail: string;
  /** Files, and functions in them, newly pushed over their size cap, if any. */
  oversizedFiles: string[];
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * A file's content at HEAD (the previous good commit), to tell what this round
 * pushed over a cap from what was over already. "" when the file is new.
 *
 * The path is a name the round's agent chose, so it is one argv entry and
 * never shell text, and the read runs no fsmonitor hook or textconv filter
 * the worktree's config could name.
 */
function headText(worktreePath: string, relPath: string): string {
  try {
    return execGitSync(
      composeGitArgs(["-c", "core.fsmonitor=false", "show", "--no-textconv", `HEAD:${relPath}`]),
      // A lockfile at HEAD is past execFileSync's 1 MiB default.
      { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, timeout: 10_000, windowsHide: true },
    );
  } catch {
    return "";
  }
}

export async function validateRound(
  worktreeName: string,
  config: AutopilotConfig,
): Promise<ValidationResult> {
  // Gate 1: any changes at all?
  const status = getWorktreeStatus(worktreeName);
  if (!status) {
    return { outcome: "noop", filesChanged: [], detail: "", oversizedFiles: [] };
  }

  const filesChanged = getWorktreeChangedFiles(worktreeName);

  // Gate 2: build
  if (config.buildCommand) {
    logger.info(`[autopilot.validate] running build: ${config.buildCommand} (timeout ${config.buildTimeoutMs}ms)`);
    const buildResult = await runCommandInWorktreeAsync(worktreeName, {
      command: config.buildCommand,
      timeoutMs: config.buildTimeoutMs,
    });
    if (!buildResult.ok) {
      const errSnippet = (buildResult.stderr || buildResult.stdout || "").slice(-2000);
      logger.warn(`[autopilot.validate] build failed in ${buildResult.durationMs}ms`);
      try { resetWorktree(worktreeName); } catch (e) { logger.warn(`[autopilot.validate] reset failed: ${(e as Error).message}`); }
      return {
        outcome: "failed-build",
        filesChanged,
        detail: errSnippet || "build command failed (no output)",
        oversizedFiles: [],
      };
    }
    logger.info(`[autopilot.validate] build passed in ${buildResult.durationMs}ms`);
  }

  // Gate 3: size delta, by the kit's rule (code lines; comments are free). A
  // part already over its cap at HEAD may be edited; one this round pushed
  // over may not.
  const limits = { ...KIT_LIMITS, maxCode: config.fileSizeLimit };
  const oversizedFiles: string[] = [];
  for (const rel of filesChanged) {
    const abs = isAbsolute(rel) ? rel : join(config.worktreePath, rel);
    if (!existsSync(abs)) continue; // deleted file — skip
    const now = overCapItems(abs, rel, readText(abs), config.worktreePath, limits);
    if (now.length === 0) continue;
    const before = new Set(overCapItems(abs, rel, headText(config.worktreePath, rel), config.worktreePath, limits).map((item) => item.key));
    for (const item of now) {
      if (!before.has(item.key)) oversizedFiles.push(`${item.key} (${item.size} ${item.unit}, cap ${item.cap})`);
    }
  }
  if (oversizedFiles.length > 0) {
    logger.warn(`[autopilot.validate] size limit exceeded: ${oversizedFiles.join(", ")}`);
    try { resetWorktree(worktreeName); } catch (e) { logger.warn(`[autopilot.validate] reset failed: ${(e as Error).message}`); }
    return {
      outcome: "failed-size",
      filesChanged,
      detail: `Pushed over the size cap (code lines; comments are free): ${oversizedFiles.join(", ")}. ` +
        "Find the job that grew and move it into a module or function named after that job, then try again. Never delete comments to fit.",
      oversizedFiles,
    };
  }

  // Gate 4: tests (opt-in)
  if (config.withTests && config.testCommand) {
    logger.info(`[autopilot.validate] running tests: ${config.testCommand}`);
    const testResult = await runCommandInWorktreeAsync(worktreeName, {
      command: config.testCommand,
      timeoutMs: config.testTimeoutMs,
    });
    if (!testResult.ok) {
      const errSnippet = (testResult.stderr || testResult.stdout || "").slice(-2000);
      logger.warn(`[autopilot.validate] tests failed in ${testResult.durationMs}ms`);
      try { resetWorktree(worktreeName); } catch (e) { logger.warn(`[autopilot.validate] reset failed: ${(e as Error).message}`); }
      return {
        outcome: "failed-test",
        filesChanged,
        detail: errSnippet || "test command failed (no output)",
        oversizedFiles: [],
      };
    }
  }

  return { outcome: "passed", filesChanged, detail: "", oversizedFiles: [] };
}

/**
 * Partition the changed-files list into in-scope vs out-of-scope, given
 * the user's scope hint patterns. Patterns are simple prefix or wildcard
 * checks ("src/cron-*" → matches by prefix, with * → suffix).
 */
export function partitionByScope(filesChanged: string[], scope: string[]): { inScope: string[]; outOfScope: string[] } {
  if (scope.length === 0) return { inScope: filesChanged, outOfScope: [] };
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const f of filesChanged) {
    if (matchesAnyScope(f, scope)) inScope.push(f);
    else outOfScope.push(f);
  }
  return { inScope, outOfScope };
}

function matchesAnyScope(file: string, patterns: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, "/").trim();
    if (!p) continue;
    if (p.includes("*")) {
      // very simple glob: convert * → .*, escape other regex meta
      const regex = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      if (regex.test(norm)) return true;
    } else {
      if (norm === p || norm.startsWith(p.endsWith("/") ? p : p + "/")) return true;
    }
  }
  return false;
}
