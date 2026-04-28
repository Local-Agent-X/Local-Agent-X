/**
 * Validate one autopilot round against its uncommitted worktree state.
 *
 * Order of gates (per plan):
 *   1. git status --porcelain → empty? → noop
 *   2. build command → fail? → revert + report error
 *   3. file-size delta check → any changed file pushed FROM ≤N TO >N? → revert
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
  runCommandInWorktree,
} from "../agency/worktree.js";
import { execSync } from "node:child_process";
import type { AutopilotConfig, RoundOutcome } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("autopilot.validate");

export interface ValidationResult {
  outcome: RoundOutcome;
  filesChanged: string[];
  /** Diagnostic detail for failure (build error, oversize file, etc.). Empty on pass/noop. */
  detail: string;
  /** Files newly pushed over the size limit, if any. */
  oversizedFiles: string[];
}

/** Count non-empty lines in a file. Used for the LOC limit check. */
function countLines(filePath: string): number {
  try {
    return readFileSync(filePath, "utf-8").split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

/**
 * Get LOC for a file at HEAD (the previous good commit) — used to compute
 * delta. If the file didn't exist at HEAD (newly created), prevLoc = 0.
 */
function getPrevLoc(worktreePath: string, relPath: string): number {
  try {
    const out = execSync(`git show HEAD:"${relPath}" 2>/dev/null | wc -l`, {
      cwd: worktreePath,
      encoding: "utf-8",
      shell: process.platform === "win32" ? "bash" : undefined,
      timeout: 10_000,
      windowsHide: true,
    });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function validateRound(
  worktreeName: string,
  config: AutopilotConfig,
): ValidationResult {
  // Gate 1: any changes at all?
  const status = getWorktreeStatus(worktreeName);
  if (!status) {
    return { outcome: "noop", filesChanged: [], detail: "", oversizedFiles: [] };
  }

  const filesChanged = getWorktreeChangedFiles(worktreeName);

  // Gate 2: build
  if (config.buildCommand) {
    logger.info(`[autopilot.validate] running build: ${config.buildCommand} (timeout ${config.buildTimeoutMs}ms)`);
    const buildResult = runCommandInWorktree(worktreeName, {
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

  // Gate 3: file-size delta
  const oversizedFiles: string[] = [];
  for (const rel of filesChanged) {
    const abs = isAbsolute(rel) ? rel : join(config.worktreePath, rel);
    if (!existsSync(abs)) continue; // deleted file — skip
    const newLoc = countLines(abs);
    if (newLoc <= config.fileSizeLimit) continue;
    const prevLoc = getPrevLoc(config.worktreePath, rel);
    if (prevLoc > config.fileSizeLimit) continue; // already over — not gated
    oversizedFiles.push(`${rel} (${prevLoc} → ${newLoc} LOC)`);
  }
  if (oversizedFiles.length > 0) {
    logger.warn(`[autopilot.validate] size limit exceeded: ${oversizedFiles.join(", ")}`);
    try { resetWorktree(worktreeName); } catch (e) { logger.warn(`[autopilot.validate] reset failed: ${(e as Error).message}`); }
    return {
      outcome: "failed-size",
      filesChanged,
      detail: `Files pushed over ${config.fileSizeLimit}-LOC limit: ${oversizedFiles.join(", ")}. Split them into focused modules and try again.`,
      oversizedFiles,
    };
  }

  // Gate 4: tests (opt-in)
  if (config.withTests && config.testCommand) {
    logger.info(`[autopilot.validate] running tests: ${config.testCommand}`);
    const testResult = runCommandInWorktree(worktreeName, {
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
