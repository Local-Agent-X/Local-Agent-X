/**
 * Rollback capture — when a profile decides "allow-with-rollback" for a
 * tool call, snapshot enough state BEFORE the tool runs that a human can
 * restore it after. Capture is best-effort; if we can't snapshot a given
 * tool's side effects, we record that fact in the contract instead of
 * faking safety.
 *
 * Storage layout under ~/.lax/rollback/:
 *   index.jsonl                       one line per captured contract
 *   {toolCallId}/<original-name>.bak  raw file backups
 *
 * Restore is currently manual (copy the .bak back, `git stash pop <ref>`).
 * An automated undo command is the next obvious layer.
 */

import { existsSync, mkdirSync, copyFileSync, statSync, appendFileSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createLogger } from "../logger.js";
import type { ToolRisk } from "./risk.js";

const logger = createLogger("autonomy-rollback");

const ROLLBACK_DIR = join(homedir(), ".lax", "rollback");
const INDEX_FILE = join(ROLLBACK_DIR, "index.jsonl");

export type RollbackArtifact =
  | { type: "file-backup"; original: string; backup: string }
  | { type: "git-stash"; ref: string; cwd: string }
  | { type: "none"; reason: string };

export interface RollbackContract {
  toolCallId: string;
  ts: number;
  tool: string;
  risk: ToolRisk;
  artifacts: RollbackArtifact[];
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function captureFileBackup(toolCallId: string, filePath: string): RollbackArtifact {
  try {
    if (!existsSync(filePath)) return { type: "none", reason: `file does not exist: ${filePath}` };
    if (statSync(filePath).isDirectory()) return { type: "none", reason: `path is a directory: ${filePath}` };
    const dir = join(ROLLBACK_DIR, toolCallId);
    ensureDir(dir);
    const backup = join(dir, basename(filePath) + ".bak");
    copyFileSync(filePath, backup);
    return { type: "file-backup", original: filePath, backup };
  } catch (e) {
    return { type: "none", reason: `backup failed: ${(e as Error).message}` };
  }
}

function captureGitStash(toolCallId: string, cwd: string): RollbackArtifact {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" });
  } catch {
    return { type: "none", reason: "cwd is not a git repository" };
  }
  try {
    const dirty = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
    if (!dirty) return { type: "none", reason: "no uncommitted changes to stash" };
    const stashMsg = `lax-rollback-${toolCallId}`;
    execSync(`git stash push --include-untracked -m "${stashMsg}"`, { cwd, stdio: "ignore" });
    const ref = execSync(`git stash list --format=%gd:%gs`, { cwd, encoding: "utf-8" })
      .split("\n").find((l) => l.includes(stashMsg))?.split(":")[0] ?? "stash@{0}";
    return { type: "git-stash", ref, cwd };
  } catch (e) {
    return { type: "none", reason: `git stash failed: ${(e as Error).message}` };
  }
}

// Tools that name their target file in args under a known key. Keep this
// short and known — guessing arg shapes leads to silent miscapture.
const PATH_ARG_KEYS = ["path", "file_path", "filepath"] as const;

function pathFromArgs(args: Record<string, unknown>, cwd: string): string | null {
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return isAbsolute(v) ? v : join(cwd, v);
  }
  return null;
}

export function captureRollback(
  toolCallId: string,
  toolName: string,
  risk: ToolRisk,
  args: Record<string, unknown>,
  cwd: string = process.cwd(),
): RollbackContract {
  ensureDir(ROLLBACK_DIR);
  const artifacts: RollbackArtifact[] = [];

  if (risk === "shell") {
    artifacts.push(captureGitStash(toolCallId, cwd));
  } else if (risk === "workspace-write" || risk === "destructive") {
    const p = pathFromArgs(args, cwd);
    if (p) {
      artifacts.push(captureFileBackup(toolCallId, p));
    } else {
      artifacts.push({ type: "none", reason: `no recognized file-path arg for ${toolName}` });
    }
  } else {
    artifacts.push({ type: "none", reason: `risk class ${risk} has no rollback capture` });
  }

  const contract: RollbackContract = {
    toolCallId,
    ts: Date.now(),
    tool: toolName,
    risk,
    artifacts,
  };

  try {
    appendFileSync(INDEX_FILE, JSON.stringify(contract) + "\n");
  } catch (e) {
    logger.warn(`[rollback] failed to append index: ${(e as Error).message}`);
  }

  return contract;
}

export const ROLLBACK_INDEX_FILE = INDEX_FILE;
export const ROLLBACK_DIR_PATH = ROLLBACK_DIR;
