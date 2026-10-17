// GENERATED from src/desktop-contract/rollback-journal.ts by scripts/check-desktop-contract.mjs --sync. Do not edit.
// The update-rollback transaction journal, as the server writes it
// (src/update-rollback.ts) and the desktop's pre-boot heal reads it
// (desktop/src/rollback-journal-heal.ts). The shape and its validator live
// here so the heal judges a journal by the writer's own rule: it used to guess
// two field names, and deleted the backups beside a journal it misread.
// Pure: hashing and path grammar only, no filesystem.

import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export const UPDATE_ROLLBACK_VERSION = 1;
/** Written into the install root beside the files an update touched. */
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

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A relative path with no empty, `.` or `..` segment, as the journal records them. */
export function safeRelative(path: string): boolean {
  return Boolean(path) && path !== "." && !isAbsolute(path) && normalize(path) === path
    && !path.split(/[\\/]/).some((part) => !part || part === "." || part === "..");
}

/** The fields the manifest commitment signs. */
export function journalManifest(journal: Omit<UpdateRollbackJournal, "manifestCommitment">): unknown {
  return {
    id: journal.id, installRoot: journal.installRoot, stateRoot: journal.stateRoot,
    installBase: journal.installBase, stateBase: journal.stateBase, previousVersion: journal.previousVersion,
    targetVersion: journal.targetVersion, entries: journal.entries, startedAt: journal.startedAt,
  };
}

function validIdentity(value: unknown): value is DirectoryIdentity {
  const item = value as Partial<DirectoryIdentity> | null;
  return !!item && typeof item.path === "string" && typeof item.real === "string"
    && typeof item.dev === "number" && typeof item.ino === "number" && typeof item.birthtimeMs === "number";
}

function validProgress(value: unknown, entries: UpdateRollbackEntry[]): value is string[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every((path) => typeof path === "string" && safeRelative(path))) return false;
  const folded = value.map((path) => path.toLocaleLowerCase("en-US"));
  const allowed = new Set(entries.map((entry) => entry.path.toLocaleLowerCase("en-US")));
  return new Set(folded).size === folded.length && folded.every((path) => allowed.has(path));
}

/** A structurally current journal whose commitment signs its manifest. */
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
  return /^[0-9a-f]{64}$/.test(journal.manifestCommitment) && hash(journalManifest(unsigned)) === journal.manifestCommitment;
}

export function validAnchor(value: unknown): value is TransactionAnchor {
  const anchor = value as TransactionAnchor | null;
  return !!anchor && anchor.version === UPDATE_ROLLBACK_VERSION && validJournal(anchor.journal)
    && (anchor.previousCommitment === null || /^[0-9a-f]{64}$/.test(anchor.previousCommitment));
}
