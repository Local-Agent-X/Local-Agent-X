import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

export const UPDATE_ROLLBACK_VERSION = 1;
export const UPDATE_ROLLBACK_ANCHOR = ".lax-update-rollback.json";

export interface DirectoryIdentity { path: string; real: string; dev: number; ino: number; birthtimeMs: number }
export interface UpdateRollbackEntry { path: string; existed: boolean; sha256: string | null }
export interface UpdateRollbackJournal {
  version: 1; id: string;
  status: "backing-up" | "active" | "applied" | "verified" | "restored";
  installRoot: string; stateRoot: string;
  installBase: DirectoryIdentity; stateBase: DirectoryIdentity;
  previousVersion: string; targetVersion: string;
  entries: UpdateRollbackEntry[]; manifestCommitment: string; startedAt: string;
  backupComplete?: string[]; restoreComplete?: string[];
  restoredAt?: string; reason?: string;
}

export interface TransactionAnchor {
  version: 1;
  journal: UpdateRollbackJournal;
  previousCommitment: string | null;
}

export function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows cannot fsync directories; the atomic rename still holds. */ }
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function samePath(left: string, right: string): boolean {
  const [a, b] = [resolve(left), resolve(right)];
  return process.platform === "win32" ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US") : a === b;
}

export function inside(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path));
  return rel !== "" && !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

export function directoryIdentity(path: string): DirectoryIdentity {
  let info;
  try { info = lstatSync(path); } catch { throw new Error(`Trusted rollback base is missing: ${path}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Trusted rollback base is linked or not a directory: ${path}`);
  const real = realpathSync(path);
  if (!samePath(real, path)) throw new Error(`Trusted rollback base has a linked ancestor: ${path}`);
  return { path: resolve(path), real: resolve(real), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

export function sameIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
  return samePath(expected.path, actual.path) && samePath(expected.real, actual.real)
    && expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeMs === actual.birthtimeMs;
}

export function safeRelative(path: string): boolean {
  return Boolean(path) && path !== "." && !isAbsolute(path) && normalize(path) === path
    && !path.split(/[\\/]/).some((part) => !part || part === "." || part === "..");
}

export function safePathChain(base: string, relativePath: string): boolean {
  if (!safeRelative(relativePath) || !inside(base, resolve(base, relativePath))) return false;
  let current = resolve(base);
  for (const part of relativePath.split(/[\\/]/)) {
    current = resolve(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !inside(base, realpathSync(current))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

function validIdentity(value: unknown): value is DirectoryIdentity {
  const item = value as Partial<DirectoryIdentity> | null;
  return !!item && typeof item.path === "string" && typeof item.real === "string"
    && typeof item.dev === "number" && typeof item.ino === "number" && typeof item.birthtimeMs === "number";
}

function manifest(journal: Omit<UpdateRollbackJournal, "manifestCommitment">): unknown {
  return {
    id: journal.id, installRoot: journal.installRoot, stateRoot: journal.stateRoot,
    installBase: journal.installBase, stateBase: journal.stateBase, previousVersion: journal.previousVersion,
    targetVersion: journal.targetVersion, entries: journal.entries, startedAt: journal.startedAt,
  };
}

function validProgress(value: unknown, entries: UpdateRollbackEntry[]): value is string[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string" && safeRelative(path))) return false;
  const folded = value.map((path) => path.toLocaleLowerCase("en-US"));
  const allowed = new Set(entries.map((entry) => entry.path.toLocaleLowerCase("en-US")));
  return new Set(folded).size === folded.length && folded.every((path) => allowed.has(path));
}

export function validJournal(value: unknown): value is UpdateRollbackJournal {
  const journal = value as UpdateRollbackJournal | null;
  if (!journal || journal.version !== UPDATE_ROLLBACK_VERSION
    || !["backing-up", "active", "applied", "verified", "restored"].includes(journal.status)) return false;
  if (typeof journal.id !== "string" || !journal.id || typeof journal.installRoot !== "string"
    || typeof journal.stateRoot !== "string" || typeof journal.previousVersion !== "string" || !journal.previousVersion
    || typeof journal.targetVersion !== "string" || !journal.targetVersion || typeof journal.startedAt !== "string"
    || !validIdentity(journal.installBase) || !validIdentity(journal.stateBase) || !Array.isArray(journal.entries)) return false;
  if (!journal.entries.every((entry) => entry && safeRelative(entry.path) && typeof entry.existed === "boolean"
    && (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)))) return false;
  const folded = journal.entries.map((entry) => entry.path.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length || !validProgress(journal.backupComplete, journal.entries)
    || !validProgress(journal.restoreComplete, journal.entries)) return false;
  if (!journal.entries.every((entry, index) => !index
    || journal.entries[index - 1]!.path.localeCompare(entry.path) <= 0)) return false;
  const { manifestCommitment: _commitment, ...unsigned } = journal;
  return /^[0-9a-f]{64}$/.test(journal.manifestCommitment) && hash(manifest(unsigned)) === journal.manifestCommitment;
}

export function validAnchor(value: unknown): value is TransactionAnchor {
  const anchor = value as TransactionAnchor | null;
  return !!anchor && anchor.version === UPDATE_ROLLBACK_VERSION && validJournal(anchor.journal)
    && (anchor.previousCommitment === null || /^[0-9a-f]{64}$/.test(anchor.previousCommitment));
}

export function parseJson(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(descriptor, "utf-8")); }
  finally { closeSync(descriptor); }
}

export function createJournal(
  installRoot: string, stateRoot: string, previousVersion: string, targetVersion: string,
  entries: UpdateRollbackEntry[], installBase: DirectoryIdentity, stateBase: DirectoryIdentity,
): UpdateRollbackJournal {
  const unsigned = {
    version: UPDATE_ROLLBACK_VERSION as 1, id: randomUUID(), status: "backing-up" as const,
    installRoot, stateRoot, installBase, stateBase, previousVersion, targetVersion, entries,
    startedAt: new Date().toISOString(), backupComplete: [], restoreComplete: [],
  };
  return { ...unsigned, manifestCommitment: hash(manifest(unsigned)) };
}
