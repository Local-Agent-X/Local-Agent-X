/**
 * Rollback capture — when a profile decides "allow-with-rollback" for a
 * tool call, snapshot enough state BEFORE the tool runs that a human can
 * restore it after. Capture is best-effort; if we can't snapshot a given
 * tool's side effects, we record that fact in the contract instead of
 * faking safety.
 *
 * Storage layout under ~/.lax/rollback/:
 *   index.jsonl                       one line per captured contract
 *   restored.jsonl                    one line per toolCallId we've undone
 *   {toolCallId}/<original-name>.bak  raw file backups
 *
 * restoreRollback() walks the contract and reverses each artifact:
 * file-backup → copyback, git-stash → stash pop. Restoration is logged
 * to restored.jsonl so listRollbacks() can mark already-undone entries.
 */

import { existsSync, mkdirSync, copyFileSync, statSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createLogger } from "../logger.js";
import type { ToolRisk } from "./risk.js";

const logger = createLogger("autonomy-rollback");

const ROLLBACK_DIR = join(homedir(), ".lax", "rollback");
const INDEX_FILE = join(ROLLBACK_DIR, "index.jsonl");
const RESTORED_FILE = join(ROLLBACK_DIR, "restored.jsonl");

export type RollbackArtifact =
  | { type: "file-backup"; original: string; backup: string }
  | { type: "git-stash"; sha: string; cwd: string }
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
    // Capture the stash commit SHA, not the positional ref. stash@{0}
    // shifts when the user (or another lax capture) pushes more stashes;
    // the SHA is stable and survives reorders.
    const sha = execSync(`git rev-parse stash@{0}`, { cwd, encoding: "utf-8" }).trim();
    return { type: "git-stash", sha, cwd };
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

// ── Restore / list ────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((x): x is T => x !== null);
}

function loadRestoredIds(): Set<string> {
  return new Set(readJsonl<{ toolCallId: string }>(RESTORED_FILE).map((r) => r.toolCallId));
}

export interface RollbackListEntry extends RollbackContract {
  restored: boolean;
}

export function listRollbacks(limit = 50): RollbackListEntry[] {
  const restored = loadRestoredIds();
  // Last entry per toolCallId wins (in case the same id ever got two
  // contracts; shouldn't happen, but be defensive about a JSONL append log).
  const byId = new Map<string, RollbackContract>();
  for (const c of readJsonl<RollbackContract>(INDEX_FILE)) byId.set(c.toolCallId, c);
  const all = Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit).map((c) => ({ ...c, restored: restored.has(c.toolCallId) }));
}

export type RestoreResult =
  | { ok: true; restored: RollbackArtifact[]; skipped: RollbackArtifact[] }
  | { ok: false; error: string };

function restoreOne(artifact: RollbackArtifact): { ok: boolean; error?: string } {
  if (artifact.type === "file-backup") {
    if (!existsSync(artifact.backup)) return { ok: false, error: `backup missing: ${artifact.backup}` };
    try { copyFileSync(artifact.backup, artifact.original); return { ok: true }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  if (artifact.type === "git-stash") {
    try {
      // Apply by SHA (stable) — see captureGitStash. `git stash drop` only
      // accepts positional refs, so look up the current stash@{n} that
      // matches our SHA at restore time. The ref may have shifted since
      // capture; the SHA hasn't.
      execSync(`git stash apply ${artifact.sha}`, { cwd: artifact.cwd, stdio: "ignore" });
      const list = execSync(`git stash list --format=%H:%gd`, { cwd: artifact.cwd, encoding: "utf-8" });
      const match = list.split("\n").find((l) => l.startsWith(artifact.sha));
      const ref = match ? match.split(":")[1] : null;
      if (ref) execSync(`git stash drop ${ref}`, { cwd: artifact.cwd, stdio: "ignore" });
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  return { ok: false, error: "no-op artifact" };
}

export function restoreRollback(toolCallId: string): RestoreResult {
  const contracts = readJsonl<RollbackContract>(INDEX_FILE).filter((c) => c.toolCallId === toolCallId);
  if (contracts.length === 0) return { ok: false, error: `no contract for ${toolCallId}` };
  if (loadRestoredIds().has(toolCallId)) return { ok: false, error: `already restored: ${toolCallId}` };

  const contract = contracts[contracts.length - 1];
  const restored: RollbackArtifact[] = [];
  const skipped: RollbackArtifact[] = [];

  for (const a of contract.artifacts) {
    if (a.type === "none") { skipped.push(a); continue; }
    const r = restoreOne(a);
    if (r.ok) restored.push(a);
    else { logger.warn(`[rollback] restore of ${a.type} failed: ${r.error}`); skipped.push(a); }
  }

  if (restored.length === 0) {
    return { ok: false, error: `nothing to restore (all ${contract.artifacts.length} artifacts were no-op or failed)` };
  }

  try { appendFileSync(RESTORED_FILE, JSON.stringify({ toolCallId, ts: Date.now() }) + "\n"); }
  catch (e) { logger.warn(`[rollback] failed to log restoration: ${(e as Error).message}`); }

  // Backups for this call are spent — file-backup artifacts have already
  // been copied back, git stashes already dropped. Reclaim the disk.
  try { rmSync(join(ROLLBACK_DIR, toolCallId), { recursive: true, force: true }); }
  catch (e) { logger.warn(`[rollback] failed to clean ${toolCallId} dir: ${(e as Error).message}`); }

  return { ok: true, restored, skipped };
}

export const ROLLBACK_INDEX_FILE = INDEX_FILE;
export const ROLLBACK_RESTORED_FILE = RESTORED_FILE;
export const ROLLBACK_DIR_PATH = ROLLBACK_DIR;
