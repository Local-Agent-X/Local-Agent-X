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

import { existsSync, mkdirSync, copyFileSync, statSync, lstatSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { execFileSync } from "node:child_process";
import { composeGitArgs } from "../git-safety.js";
import { getRuntimeConfig } from "../config.js";
import { evaluateFileAccess, loadFileAccessMode } from "../security/layer/index.js";
import { createLogger } from "../logger.js";
import type { ToolRisk } from "./risk.js";

const logger = createLogger("autonomy-rollback");

const ROLLBACK_DIR = join(getLaxDir(), "rollback");
const INDEX_FILE = join(ROLLBACK_DIR, "index.jsonl");
const RESTORED_FILE = join(ROLLBACK_DIR, "restored.jsonl");

// A tool-call id names a directory under ROLLBACK_DIR that a restore deletes
// recursively, and it comes back out of an index any file writer can append
// to: no path separator, no leading dot. "|" stays: one provider's ids join a
// call id and an item id with it.
const TOOL_CALL_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.|-]{0,199}$/;
const STASH_SHA = /^[0-9a-f]{40}$/;

/** git as argv, never a shell string: the stash message carries the tool-call
 *  id, and a restore's sha and directory are read back from the index. Starts
 *  no fsmonitor hook the repository's config could name. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", composeGitArgs(["-c", "core.fsmonitor=false", ...args]), {
    cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

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
  // Self-protect: never stash the LAX dev repo itself. captureRollback's
  // default cwd is process.cwd(); during tests that's this repo, and a
  // shell-class tool dispatched without an explicit cwd would otherwise
  // git-stash live working-tree edits out from under the developer.
  // Users running LAX against their own project repos won't match.
  if (existsSync(join(cwd, "src", "autonomy", "rollback.ts"))) {
    return { type: "none", reason: "refusing to stash LAX source repo" };
  }
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    return { type: "none", reason: "cwd is not a git repository" };
  }
  try {
    const dirty = git(["status", "--porcelain"], cwd).trim();
    if (!dirty) return { type: "none", reason: "no uncommitted changes to stash" };
    git(["stash", "push", "--include-untracked", "-m", `lax-rollback-${toolCallId}`], cwd);
    // Capture the stash commit SHA, not the positional ref. stash@{0}
    // shifts when the user (or another lax capture) pushes more stashes;
    // the SHA is stable and survives reorders.
    const sha = git(["rev-parse", "stash@{0}"], cwd).trim();
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

  if (!TOOL_CALL_ID.test(toolCallId)) {
    artifacts.push({ type: "none", reason: "the tool call id cannot name a backup directory" });
  } else if (risk === "shell") {
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

/**
 * Where a file backup may be copied back to, or why not. The index is an
 * ordinary file under ~/.lax that any file writer can append to, so a restore
 * trusts no path a line names: the backup must be a regular file capture wrote
 * for this call (not a symlink to, say, a key file the copy would publish),
 * and the original must be a path the file-access layer lets a write reach,
 * the same answer the write tools get.
 */
function backupTarget(toolCallId: string, a: { original: unknown; backup: unknown }): { target: string } | { error: string } {
  if (typeof a.original !== "string" || typeof a.backup !== "string" || !isAbsolute(a.original)) {
    return { error: "the contract's file paths are malformed" };
  }
  if (dirname(resolve(a.backup)) !== join(ROLLBACK_DIR, toolCallId)) return { error: `not a backup of this call: ${a.backup}` };
  if (!existsSync(a.backup)) return { error: `backup missing: ${a.backup}` };
  if (!lstatSync(a.backup).isFile()) return { error: `backup is not a regular file: ${a.backup}` };
  const d = evaluateFileAccess(getRuntimeConfig().workspace, loadFileAccessMode(), () => false, "write", a.original);
  return d.allowed ? { target: d.canonicalPath ?? a.original } : { error: `refusing to write ${a.original}: ${d.reason}` };
}

function restoreOne(toolCallId: string, artifact: RollbackArtifact): { ok: boolean; error?: string } {
  if (artifact.type === "file-backup") {
    const to = backupTarget(toolCallId, artifact);
    if ("error" in to) return { ok: false, error: to.error };
    try { copyFileSync(artifact.backup, to.target); return { ok: true }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  if (artifact.type === "git-stash") {
    if (typeof artifact.sha !== "string" || !STASH_SHA.test(artifact.sha)) {
      return { ok: false, error: `not a stash commit sha: ${String(artifact.sha)}` };
    }
    try {
      // Apply by SHA (stable) — see captureGitStash. `git stash drop` only
      // accepts positional refs, so look up the current stash@{n} that
      // matches our SHA at restore time. The ref may have shifted since
      // capture; the SHA hasn't.
      git(["stash", "apply", artifact.sha], artifact.cwd);
      const list = git(["stash", "list", "--format=%H:%gd"], artifact.cwd);
      const match = list.split("\n").find((l) => l.startsWith(artifact.sha));
      const ref = match ? match.split(":")[1] : null;
      if (ref) git(["stash", "drop", ref], artifact.cwd);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  return { ok: false, error: "no-op artifact" };
}

export function restoreRollback(toolCallId: string): RestoreResult {
  if (!TOOL_CALL_ID.test(toolCallId)) return { ok: false, error: `not a tool call id: ${toolCallId}` };
  const contracts = readJsonl<RollbackContract>(INDEX_FILE).filter((c) => c.toolCallId === toolCallId);
  if (contracts.length === 0) return { ok: false, error: `no contract for ${toolCallId}` };
  if (loadRestoredIds().has(toolCallId)) return { ok: false, error: `already restored: ${toolCallId}` };

  const contract = contracts[contracts.length - 1];
  const restored: RollbackArtifact[] = [];
  const skipped: RollbackArtifact[] = [];

  for (const a of contract.artifacts) {
    if (a.type === "none") { skipped.push(a); continue; }
    const r = restoreOne(toolCallId, a);
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
