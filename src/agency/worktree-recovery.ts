/** Durable ownership and boot recovery for canonical agent worktrees. */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { atomicWriteFileSync } from "../util/json-store.js";
import {
  activeWorktrees, git, logger, MAX_PENDING_RECOVERED_WORKTREES,
  pendingRecoveredWorktrees, type WorktreeEntry, WORKTREE_BASE, worktreeSlotAvailable,
} from "./worktree-core.js";
import { unlinkAllShallowReparsePoints } from "./worktree-junctions.js";
import { reapAppOwnWorktrees } from "./worktree-boot-sweep.js";
import { currentProcessIncarnation, processIncarnationIsLive } from "./worktree-process.js";

interface OwnershipRecord {
  version: 2;
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  runId: string;
  ownerPid: number;
  ownerIncarnation: string;
  ownerToken: string;
  generation: number;
  createdAt: string;
}

interface ClaimLease {
  pid: number;
  incarnation: string;
  token: string;
  createdAt: string;
}

interface GitWorktree { path: string; branch?: string; detached: boolean }

export type RecoveryDisposition = "live" | "recoverable" | "disposable" | "ambiguous";
export interface WorktreeRecoveryResult {
  name: string;
  path: string;
  disposition: RecoveryDisposition;
  reason: string;
}

type IncarnationProbe = (pid: number, incarnation: string) => boolean;
export interface RecoveryTestHooks {
  beforeStaleRename?: (claimPath: string) => void;
}

function canonical(path: string): string {
  let value: string;
  try { value = realpathSync.native(path); } catch { value = resolve(path); }
  value = resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function commonGitDir(cwd: string): string {
  return resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
}

export function worktreeOwnershipRecordPath(wtPath: string): string {
  const key = createHash("sha256").update(canonical(wtPath)).digest("hex");
  return join(commonGitDir(wtPath), "lax-worktrees", `${key}.json`);
}

function validRecord(value: unknown): value is OwnershipRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.version === 2
    && typeof r.name === "string" && r.name.length > 0
    && typeof r.path === "string" && isAbsolute(r.path)
    && typeof r.branch === "string" && r.branch.length > 0
    && typeof r.baseBranch === "string" && r.baseBranch.length > 0
    && typeof r.repoRoot === "string" && isAbsolute(r.repoRoot)
    && typeof r.runId === "string" && r.runId.length > 0
    && Number.isInteger(r.ownerPid) && (r.ownerPid as number) > 0
    && typeof r.ownerIncarnation === "string" && r.ownerIncarnation.length > 0
    && typeof r.ownerToken === "string" && r.ownerToken.length >= 16
    && Number.isInteger(r.generation) && (r.generation as number) > 0
    && typeof r.createdAt === "string";
}

function readRecord(wtPath: string): OwnershipRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(worktreeOwnershipRecordPath(wtPath), "utf-8"));
    return validRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function writeRecord(record: OwnershipRecord): void {
  const path = worktreeOwnershipRecordPath(record.path);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
}

function sameRepository(a: string, b: string): boolean {
  try { return canonical(commonGitDir(a)) === canonical(commonGitDir(b)); }
  catch { return false; }
}

function identityMatches(record: OwnershipRecord, actual: GitWorktree): boolean {
  return canonical(record.path) === canonical(actual.path)
    && !actual.detached && record.branch === actual.branch
    && sameRepository(record.repoRoot, actual.path);
}

function parseWorktreeList(raw: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const block of raw.split("\0\0")) {
    const fields = block.split("\0").filter(Boolean);
    const path = fields.find(v => v.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const ref = fields.find(v => v.startsWith("branch "))?.slice(7);
    out.push({ path, branch: ref?.replace(/^refs\/heads\//, ""), detached: fields.includes("detached") });
  }
  return out;
}

function ownershipEntry(record: OwnershipRecord, recovered: boolean): WorktreeEntry {
  return {
    path: record.path, branch: record.branch, baseBranch: record.baseBranch,
    repoRoot: record.repoRoot, runId: record.runId, mergedSuccessfully: false,
    ownerToken: record.ownerToken, ownerGeneration: record.generation, recovered,
  };
}

export function registerWorktreeOwnership(
  name: string,
  entry: WorktreeEntry,
  runId = entry.runId ?? name,
): WorktreeEntry {
  const prior = readRecord(entry.path);
  const record: OwnershipRecord = {
    version: 2, name, path: entry.path, branch: entry.branch,
    baseBranch: entry.baseBranch, repoRoot: entry.repoRoot, runId,
    ownerPid: process.pid, ownerIncarnation: currentProcessIncarnation(),
    ownerToken: randomUUID(), generation: (prior?.generation ?? 0) + 1,
    createdAt: new Date().toISOString(),
  };
  writeRecord(record);
  return ownershipEntry(record, false);
}

export function ownsWorktree(entry: WorktreeEntry): boolean {
  if (!entry.ownerToken || !entry.ownerGeneration) return true;
  const record = readRecord(entry.path);
  return record?.ownerToken === entry.ownerToken
    && record.generation === entry.ownerGeneration
    && record.runId === entry.runId
    && canonical(record.path) === canonical(entry.path);
}

export function forgetWorktreeOwnership(entry: WorktreeEntry): void {
  if (!ownsWorktree(entry)) return;
  try { unlinkSync(worktreeOwnershipRecordPath(entry.path)); } catch { /* absent or newer owner */ }
}

function validLease(value: unknown): value is ClaimLease {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.pid) && (v.pid as number) > 0
    && typeof v.incarnation === "string" && typeof v.token === "string"
    && typeof v.createdAt === "string";
}

function readLease(path: string): ClaimLease | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return validLease(value) ? value : null;
  } catch { return null; }
}

interface ClaimSnapshot { raw: string; lease: ClaimLease | null }

function readClaimSnapshot(path: string): ClaimSnapshot | null {
  try {
    const raw = readFileSync(path, "utf-8");
    let value: unknown = null;
    try { value = JSON.parse(raw); } catch { /* malformed prior crash claim */ }
    return { raw, lease: validLease(value) ? value : null };
  } catch { return null; }
}

function cleanupOrphanClaimCandidates(path: string): void {
  const prefix = `${basename(path)}.candidate-`;
  const cutoff = Date.now() - 24 * 60 * 60_000;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue;
      const candidate = join(dirname(path), name);
      if (statSync(candidate).mtimeMs < cutoff) try { unlinkSync(candidate); } catch { /* live writer */ }
    }
  } catch { /* candidate cleanup never decides ownership */ }
}

interface ClaimLock {
  owns: () => boolean;
  release: () => void;
}

function acquireClaimLock(
  wtPath: string, probe: IncarnationProbe, hooks?: RecoveryTestHooks,
): ClaimLock | null {
  const path = worktreeOwnershipRecordPath(wtPath) + ".claim";
  const token = randomUUID();
  const lease: ClaimLease = {
    pid: process.pid, incarnation: currentProcessIncarnation(), token,
    createdAt: new Date().toISOString(),
  };
  cleanupOrphanClaimCandidates(path);
  const candidate = `${path}.candidate-${token}`;
  try {
    const fd = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(lease));
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch { return null; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      linkSync(candidate, path);
      try { unlinkSync(candidate); } catch { /* published claim remains valid */ }
      const owns = () => readLease(path)?.token === token;
      return { owns, release: () => {
        if (readLease(path)?.token === token) try { unlinkSync(path); } catch { /* newer lease */ }
      } };
    } catch {
      const existing = readClaimSnapshot(path);
      if (existing?.lease && probe(existing.lease.pid, existing.lease.incarnation)) {
        try { unlinkSync(candidate); } catch { /* private candidate */ }
        return null;
      }
      const stale = `${path}.stale-${randomUUID()}`;
      hooks?.beforeStaleRename?.(path);
      try { renameSync(path, stale); } catch { continue; }
      const moved = readClaimSnapshot(stale);
      if (!existing || !moved || existing.raw !== moved.raw) {
        try { renameSync(stale, path); } catch { /* preserve moved claimant lease */ }
        try { unlinkSync(candidate); } catch { /* private candidate */ }
        return null;
      }
      try { unlinkSync(stale); } catch {
        try { unlinkSync(candidate); } catch { /* private candidate */ }
        return null;
      }
    }
  }
  try { unlinkSync(candidate); } catch { /* private candidate */ }
  return null;
}

function branchIsMerged(record: OwnershipRecord): boolean {
  try { git(["merge-base", "--is-ancestor", record.branch, record.baseBranch], record.repoRoot); return true; }
  catch { return false; }
}

function safeDirectChild(path: string, base: string): boolean {
  return dirname(canonical(path)) === canonical(base) && basename(path).length > 0;
}

function disposeRegistered(record: OwnershipRecord, base: string): boolean {
  if (!safeDirectChild(record.path, base)) return false;
  if (unlinkAllShallowReparsePoints(record.path).length) return false;
  try {
    forgetWorktreeOwnership(ownershipEntry(record, false));
    git(["worktree", "remove", record.path, "--force"], record.repoRoot);
    try { git(["branch", "-d", record.branch], record.repoRoot); } catch { /* absent */ }
    return true;
  } catch { return false; }
}

function classifyDirectory(
  name: string, wtPath: string, base: string, probe: IncarnationProbe,
  hooks?: RecoveryTestHooks,
): WorktreeRecoveryResult {
  let worktrees: GitWorktree[];
  try { worktrees = parseWorktreeList(git(["worktree", "list", "--porcelain", "-z"], wtPath)); }
  catch { return { name, path: wtPath, disposition: "ambiguous", reason: "not a verifiable git worktree" }; }
  const actual = worktrees.find(w => canonical(w.path) === canonical(wtPath));
  const record = readRecord(wtPath);
  if (!actual || !record || !identityMatches(record, actual) || record.name !== name) {
    return { name, path: wtPath, disposition: "ambiguous", reason: "durable identity missing or mismatched" };
  }
  if (probe(record.ownerPid, record.ownerIncarnation)) {
    return { name, path: wtPath, disposition: "live", reason: `owned by live process ${record.ownerIncarnation}` };
  }
  let dirty: string;
  try { dirty = git(["status", "--porcelain"], wtPath); }
  catch { return { name, path: wtPath, disposition: "ambiguous", reason: "git status unavailable" }; }
  if (!dirty && branchIsMerged(record)) {
    return disposeRegistered(record, base)
      ? { name, path: wtPath, disposition: "disposable", reason: "clean branch already integrated" }
      : { name, path: wtPath, disposition: "ambiguous", reason: "safe disposal failed" };
  }
  if (pendingRecoveredWorktrees.size >= MAX_PENDING_RECOVERED_WORKTREES) {
    return { name, path: wtPath, disposition: "ambiguous", reason: "recovery quarantine is full; work preserved" };
  }
  if (pendingRecoveredWorktrees.has(name)) {
    return { name, path: wtPath, disposition: "ambiguous", reason: "duplicate recovery identity; work preserved" };
  }
  const claim = acquireClaimLock(wtPath, probe, hooks);
  if (!claim) return { name, path: wtPath, disposition: "ambiguous", reason: "ownership claim is contested" };
  try {
    if (!claim.owns()) {
      return { name, path: wtPath, disposition: "ambiguous", reason: "ownership claim changed before adoption" };
    }
    const claimed = registerWorktreeOwnership(name, ownershipEntry(record, true), record.runId);
    claimed.recovered = true;
    if (!claim.owns() || !ownsWorktree(claimed)) {
      return { name, path: wtPath, disposition: "ambiguous", reason: "ownership fence changed during adoption" };
    }
    pendingRecoveredWorktrees.set(name, claimed);
    return {
      name, path: wtPath, disposition: "recoverable",
      reason: dirty ? "uncommitted work preserved and quarantined" : "unmerged branch preserved and quarantined",
    };
  } finally { claim.release(); }
}

export interface RecoveredWorktreeRequest {
  name: string;
  branch: string;
  runId: string;
  repoRoot: string;
  baseBranch: string;
  beforeReturn?: () => void;
}

export function claimRecoveredWorktree(request: RecoveredWorktreeRequest): WorktreeEntry | null {
  if (!worktreeSlotAvailable()) return null;
  const entry = pendingRecoveredWorktrees.get(request.name);
  if (!entry || entry.branch !== request.branch || entry.runId !== request.runId
      || entry.baseBranch !== request.baseBranch || !sameRepository(entry.repoRoot, request.repoRoot)
      || !ownsWorktree(entry)) return null;
  pendingRecoveredWorktrees.delete(request.name);
  entry.recovered = false;
  activeWorktrees.set(request.name, entry);
  request.beforeReturn?.();
  if (!ownsWorktree(entry)) {
    activeWorktrees.delete(request.name);
    return null;
  }
  return entry;
}

export async function reconcileWorktreeBase(
  base = WORKTREE_BASE,
  probe: IncarnationProbe = processIncarnationIsLive,
  hooks?: RecoveryTestHooks,
): Promise<WorktreeRecoveryResult[]> {
  if (!existsSync(base)) return [];
  let names: string[];
  try { names = readdirSync(base); } catch { return []; }
  const results: WorktreeRecoveryResult[] = [];
  for (const name of names) {
    const wtPath = join(base, name);
    try { if (!lstatSync(wtPath).isDirectory() || !safeDirectChild(wtPath, base)) continue; }
    catch { continue; }
    results.push(classifyDirectory(name, wtPath, base, probe, hooks));
  }
  if (canonical(base) === canonical(WORKTREE_BASE)) {
    reapAppOwnWorktrees();
  }
  for (const result of results) {
    logger.info(`[worktree] recovery ${result.disposition}: ${result.path} (${result.reason})`);
  }
  return results;
}

export async function sweepOrphanWorktreeJunctions(): Promise<void> {
  await reconcileWorktreeBase();
}
