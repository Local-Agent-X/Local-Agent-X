/**
 * Rollback store — the bytes a file had before the agent changed it, so the
 * change can be undone. Every tool call that writes or deletes a file captures
 * here before it runs (tool-execution/capture-rollback.ts, which reads the
 * paths off the policy rows), in every autonomy profile: a file the call will
 * edit or delete is copied aside, a file it will create is recorded as created.
 * Each capture is a contract keyed by the tool call and tagged with its
 * session and request (op). Two steps: captureBeforeCall copies, then
 * recordCapture, after the call ran, keeps only what the call changed, so a
 * shell command's operand it merely read (a script, an input file) is neither
 * listed as changed nor put back over later edits.
 *
 * Two ways back:
 *   restoreRollback(toolCallId)          one call (Settings → Rollback)
 *   rewindToBeforeOp(sessionId, opId)    every file changed from that request
 *                                        on (rollback-rewind.ts, the chat's Undo)
 *
 * A shell command is captured by the files its text names
 * (tool-execution/capture-rollback.ts). What it changes without naming (a
 * build's outputs, a file a script opens itself) is not. A git stash of the
 * work tree used to stand in, and stashing takes the user's uncommitted work
 * OUT of the tree before the command runs.
 *
 * Storage under ~/.lax/rollback/:
 *   index.jsonl                       one line per captured contract
 *   restored.jsonl                    one line per toolCallId we've undone
 *   {toolCallId}/<n>-<name>.bak       raw file backups
 * Contracts older than RETENTION_MS are pruned, with their backups.
 */

import { existsSync, mkdirSync, copyFileSync, statSync, lstatSync, appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { getRuntimeConfig } from "../config.js";
import { evaluateFileAccess, loadFileAccessMode } from "../security/layer/index.js";
import { moveToTrash } from "../safe-delete.js";
import { SEALED_TTL_MS, openBackup, sealBackup } from "./rollback-seal.js";
import { createLogger } from "../logger.js";

const logger = createLogger("autonomy-rollback");

const ROLLBACK_DIR = join(getLaxDir(), "rollback");
const INDEX_FILE = join(ROLLBACK_DIR, "index.jsonl");
const RESTORED_FILE = join(ROLLBACK_DIR, "restored.jsonl");

// A tool-call id names a directory under ROLLBACK_DIR that a restore deletes
// recursively, and it comes back out of an index any file writer can append
// to: no path separator, no leading dot. "|" stays: one provider's ids join a
// call id and an item id with it.
const TOOL_CALL_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.|-]{0,199}$/;

/** A file larger than this is not copied aside before every write: a model
 *  rewriting a large data file in a loop would fill the disk with copies. */
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
/** How long a capture can be undone. */
const RETENTION_MS = 30 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;

export type RollbackArtifact =
  /** `sealed`: the backup is encrypted (rollback-seal.ts) and expires at
   *  `expiresAt`; absent, a plain copy kept for the whole retention window. */
  | { type: "file-backup"; original: string; backup: string; sealed?: true; expiresAt?: number }
  | { type: "created"; original: string }
  /** A credential file the user named for deletion: the delete is on record,
   *  and no copy was kept, so nothing can undo it. */
  | { type: "final"; original: string; reason: string }
  | { type: "none"; reason: string };

/** How a captured file's bytes are kept: a plain copy (the default), sealed
 *  (a credential file the agent changes on its own), or not at all (`final`:
 *  a credential file the user named for deletion). Decided by the caller
 *  (tool-execution/capture-rollback.ts), which knows the request. */
export type CaptureKeep = "copy" | "seal" | "final";
export type CapturePath = string | { path: string; keep: CaptureKeep };
const KEEP_RANK: Record<CaptureKeep, number> = { copy: 0, seal: 1, final: 2 };

export interface RollbackCall {
  toolCallId: string;
  tool: string;
  sessionId?: string;
  opId?: string;
}

export interface RollbackContract extends RollbackCall {
  ts: number;
  artifacts: RollbackArtifact[];
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** What a path held when it was captured, to tell afterwards whether the call
 *  changed it. Kept in memory between the two steps, never on record. */
interface Before { exists: boolean; size: number; mtimeMs: number }

function statBefore(p: string): Before {
  try { const st = statSync(p); return { exists: true, size: st.size, mtimeMs: st.mtimeMs }; }
  catch { return { exists: false, size: 0, mtimeMs: 0 }; }
}

function captureFile(toolCallId: string, filePath: string, n: number, keep: CaptureKeep, now: number): RollbackArtifact {
  try {
    if (!existsSync(filePath)) return { type: "created", original: filePath };
    const st = statSync(filePath);
    if (st.isDirectory()) return { type: "none", reason: `${filePath} is a folder: a deleted folder goes to the trash, and restore_file brings it back` };
    if (st.size > MAX_BACKUP_BYTES) return { type: "none", reason: `${filePath} is ${st.size} bytes, over the ${MAX_BACKUP_BYTES}-byte backup cap` };
    if (keep === "final") return { type: "final", original: filePath, reason: "a credential file the user named for deletion: no copy is kept" };
    const dir = join(ROLLBACK_DIR, toolCallId);
    ensureDir(dir);
    if (keep === "seal") {
      const backup = join(dir, `${n}-${basename(filePath)}.sealed`);
      sealBackup(filePath, backup, toolCallId);
      return { type: "file-backup", original: filePath, backup, sealed: true, expiresAt: now + SEALED_TTL_MS };
    }
    const backup = join(dir, `${n}-${basename(filePath)}.bak`);
    copyFileSync(filePath, backup);
    return { type: "file-backup", original: filePath, backup };
  } catch (e) {
    return { type: "none", reason: `backup of ${filePath} failed: ${(e as Error).message}` };
  }
}

/** The bytes a backup holds, opened when sealed. Throws when it cannot be read. */
export function backupBytes(toolCallId: string, a: Extract<RollbackArtifact, { type: "file-backup" }>): Buffer {
  return a.sealed ? openBackup(a.backup, toolCallId) : readFileSync(a.backup);
}

/** A sealed backup past its time: swept by the prune, refused by a restore. */
const expired = (a: RollbackArtifact, now: number): boolean =>
  a.type === "file-backup" && a.sealed === true && typeof a.expiresAt === "number" && a.expiresAt <= now;

let lastPruneAt = 0;

export interface PendingCapture {
  call: RollbackCall;
  ts: number;
  entries: Array<{ path: string | null; before: Before; artifact: RollbackArtifact }>;
}

/**
 * Before the call: copy aside every file it may change. `paths` are absolute,
 * resolved the way the tool resolves them. Null when the call names no file.
 * Nothing is on record until recordCapture.
 */
export function captureBeforeCall(call: RollbackCall, paths: readonly CapturePath[], now = Date.now()): PendingCapture | null {
  if (paths.length === 0) return null;
  ensureDir(ROLLBACK_DIR);
  if (now - lastPruneAt > PRUNE_EVERY_MS) pruneRollbacks(now);
  if (!TOOL_CALL_ID.test(call.toolCallId)) {
    return { call, ts: now, entries: [{ path: null, before: statBefore(""), artifact: { type: "none", reason: "the tool call id cannot name a backup directory" } }] };
  }
  const keeps = new Map<string, CaptureKeep>();
  for (const p of paths) {
    const path = typeof p === "string" ? p : p.path;
    const keep = typeof p === "string" ? "copy" : p.keep;
    // A path named twice keeps the stricter rule: a copy of what any
    // spelling says is a credential is still a copy of a credential.
    if (KEEP_RANK[keep] > KEEP_RANK[keeps.get(path) ?? "copy"] || !keeps.has(path)) keeps.set(path, keep);
  }
  const entries = [...keeps].map(([p, keep], i) => ({ path: p, before: statBefore(p), artifact: captureFile(call.toolCallId, p, i, keep, now) }));
  return { call, ts: now, entries };
}

function changedSince(toolCallId: string, path: string, before: Before, artifact: RollbackArtifact): boolean {
  const now = statBefore(path);
  if (now.exists !== before.exists) return true;
  if (!now.exists) return false;
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) return true;
  if (artifact.type !== "file-backup") return false;
  // Same size and time stamp: a rewrite inside one clock tick. The bytes decide.
  try { return !readFileSync(path).equals(backupBytes(toolCallId, artifact)); } catch { return true; }
}

/**
 * After the call: keep what it changed (rewrote, deleted, created; a folder or
 * an over-cap file that went or changed keeps its reason), drop the copies of
 * the rest, and put the capture on record. Null when it changed nothing.
 */
export function recordCapture(pending: PendingCapture | null): RollbackContract | null {
  if (!pending) return null;
  const kept: RollbackArtifact[] = [];
  for (const { path, before, artifact } of pending.entries) {
    if (path && changedSince(pending.call.toolCallId, path, before, artifact)) kept.push(artifact);
    else if (artifact.type === "file-backup") rmSync(artifact.backup, { force: true });
  }
  if (kept.length === 0) {
    if (TOOL_CALL_ID.test(pending.call.toolCallId)) rmSync(join(ROLLBACK_DIR, pending.call.toolCallId), { recursive: true, force: true });
    return null;
  }
  const contract: RollbackContract = { ...pending.call, ts: pending.ts, artifacts: kept };
  try {
    appendFileSync(INDEX_FILE, JSON.stringify(contract) + "\n");
  } catch (e) {
    logger.warn(`[rollback] failed to append index: ${(e as Error).message}`);
  }
  return contract;
}

/** A contract with every sealed backup past its time swept: the bytes are
 *  removed and the artifact keeps only the fact, so the index still says the
 *  file was changed and the Settings list says why it cannot come back. */
function sweepExpired(c: RollbackContract, now: number): { contract: RollbackContract; swept: boolean } {
  if (!c.artifacts.some((a) => expired(a, now))) return { contract: c, swept: false };
  const artifacts = c.artifacts.map((a): RollbackArtifact => {
    if (!expired(a, now) || a.type !== "file-backup") return a;
    if (TOOL_CALL_ID.test(c.toolCallId) && dirname(resolve(a.backup)) === join(ROLLBACK_DIR, c.toolCallId)) rmSync(a.backup, { force: true });
    return { type: "none", reason: `the sealed backup of ${a.original} expired after ${SEALED_TTL_MS / 3_600_000} hours` };
  });
  return { contract: { ...c, artifacts }, swept: true };
}

/** Drop contracts older than the retention window, with their backups, and
 *  the sealed backups past their shorter window. */
export function pruneRollbacks(now = Date.now()): number {
  lastPruneAt = now;
  const all = readContracts();
  const live = all.filter((c) => now - c.ts < RETENTION_MS);
  const sweeps = live.map((c) => sweepExpired(c, now));
  const keep = sweeps.map((s) => s.contract);
  if (keep.length === all.length && !sweeps.some((s) => s.swept)) return 0;
  const kept = new Set(keep.map((c) => c.toolCallId));
  for (const c of all) {
    if (!kept.has(c.toolCallId) && TOOL_CALL_ID.test(c.toolCallId)) {
      rmSync(join(ROLLBACK_DIR, c.toolCallId), { recursive: true, force: true });
    }
  }
  writeFileSync(INDEX_FILE, keep.map((c) => JSON.stringify(c) + "\n").join(""));
  const restored = readJsonl<{ toolCallId: string }>(RESTORED_FILE).filter((r) => kept.has(r.toolCallId));
  writeFileSync(RESTORED_FILE, restored.map((r) => JSON.stringify(r) + "\n").join(""));
  return all.length - keep.length;
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

/** Every contract on record, oldest first. */
export function readContracts(): RollbackContract[] {
  return readJsonl<RollbackContract>(INDEX_FILE).sort((a, b) => a.ts - b.ts);
}

export function loadRestoredIds(): Set<string> {
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
  for (const c of readContracts()) byId.set(c.toolCallId, c);
  const all = Array.from(byId.values()).sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit).map((c) => ({ ...c, restored: restored.has(c.toolCallId) }));
}

export type RestoreResult =
  | { ok: true; restored: RollbackArtifact[]; skipped: RollbackArtifact[] }
  | { ok: false; error: string };

/**
 * Where an undo may write or remove, or why not. The index is an ordinary
 * file under ~/.lax that any file writer can append to, so a restore trusts no
 * path a line names: a backup must be a regular file capture wrote for this
 * call (not a symlink to, say, a key file the copy would publish), and the
 * original must be a path the file-access layer lets the same action reach,
 * the same answer the file tools get.
 */
function undoTarget(toolCallId: string, a: RollbackArtifact, sessionId?: string): { target: string } | { error: string } {
  if (a.type === "none") return { error: "no-op artifact" };
  if (a.type === "final") return { error: `${a.original} cannot come back: ${a.reason}` };
  if (typeof a.original !== "string" || !isAbsolute(a.original)) return { error: "the contract's file paths are malformed" };
  if (a.type === "file-backup") {
    if (typeof a.backup !== "string") return { error: "the contract's file paths are malformed" };
    if (dirname(resolve(a.backup)) !== join(ROLLBACK_DIR, toolCallId)) return { error: `not a backup of this call: ${a.backup}` };
    if (expired(a, Date.now())) return { error: `the sealed backup of ${a.original} expired` };
    if (!existsSync(a.backup)) return { error: `backup missing: ${a.backup}` };
    if (!lstatSync(a.backup).isFile()) return { error: `backup is not a regular file: ${a.backup}` };
  }
  const action = a.type === "created" ? "delete_file" : "write";
  const d = evaluateFileAccess(getRuntimeConfig().workspace, loadFileAccessMode(), () => false, action, a.original, sessionId);
  return d.allowed ? { target: d.canonicalPath ?? a.original } : { error: `refusing to ${action === "write" ? "write" : "remove"} ${a.original}: ${d.reason}` };
}

/** Put one artifact back: copy a backup over the file, or move a file the
 *  call created to the trash (so the undo itself can be undone). */
export async function undoArtifact(toolCallId: string, a: RollbackArtifact, sessionId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const to = undoTarget(toolCallId, a, sessionId);
  if ("error" in to) return { ok: false, error: to.error };
  try {
    if (a.type === "file-backup") {
      if (a.sealed) writeFileSync(to.target, backupBytes(toolCallId, a));
      else copyFileSync(a.backup, to.target);
    } else if (existsSync(to.target) && !(await moveToTrash(to.target, "undo"))) {
      return { ok: false, error: `could not move ${to.target} to the trash` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Mark calls undone and reclaim their backups: they are spent. */
export function markRestored(toolCallIds: readonly string[], now = Date.now()): void {
  for (const id of toolCallIds) {
    try { appendFileSync(RESTORED_FILE, JSON.stringify({ toolCallId: id, ts: now }) + "\n"); }
    catch (e) { logger.warn(`[rollback] failed to log restoration: ${(e as Error).message}`); }
    if (!TOOL_CALL_ID.test(id)) continue;
    try { rmSync(join(ROLLBACK_DIR, id), { recursive: true, force: true }); }
    catch (e) { logger.warn(`[rollback] failed to clean ${id} dir: ${(e as Error).message}`); }
  }
}

export async function restoreRollback(toolCallId: string): Promise<RestoreResult> {
  if (!TOOL_CALL_ID.test(toolCallId)) return { ok: false, error: `not a tool call id: ${toolCallId}` };
  const contracts = readContracts().filter((c) => c.toolCallId === toolCallId);
  if (contracts.length === 0) return { ok: false, error: `no contract for ${toolCallId}` };
  if (loadRestoredIds().has(toolCallId)) return { ok: false, error: `already restored: ${toolCallId}` };

  const contract = contracts[contracts.length - 1];
  const restored: RollbackArtifact[] = [];
  const skipped: RollbackArtifact[] = [];
  for (const a of contract.artifacts) {
    if (a.type === "none") { skipped.push(a); continue; }
    const r = await undoArtifact(toolCallId, a, contract.sessionId);
    if (r.ok) restored.push(a);
    else { logger.warn(`[rollback] restore of ${a.type} failed: ${r.error}`); skipped.push(a); }
  }
  if (restored.length === 0) {
    return { ok: false, error: `nothing to restore (all ${contract.artifacts.length} artifacts were no-op or failed)` };
  }
  markRestored([toolCallId]);
  return { ok: true, restored, skipped };
}

export const ROLLBACK_INDEX_FILE = INDEX_FILE;
export const ROLLBACK_RESTORED_FILE = RESTORED_FILE;
export const ROLLBACK_DIR_PATH = ROLLBACK_DIR;
