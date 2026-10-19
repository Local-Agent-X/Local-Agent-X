// The update-rollback transaction's on-disk helpers. The journal shape and its
// validator are part of the desktop↔server contract (src/desktop-contract/
// rollback-journal.ts): the desktop's pre-boot heal judges a journal by the
// same rule this module writes it by.

import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  hash, journalManifest, safeRelative, UPDATE_ROLLBACK_VERSION,
  type DirectoryIdentity, type UpdateRollbackEntry, type UpdateRollbackJournal,
} from "./desktop-contract/rollback-journal.js";

export {
  hash, safeRelative, validAnchor, validJournal, UPDATE_ROLLBACK_ANCHOR, UPDATE_ROLLBACK_VERSION,
  type DirectoryIdentity, type TransactionAnchor, type UpdateRollbackEntry, type UpdateRollbackJournal,
} from "./desktop-contract/rollback-journal.js";

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

export function safePathChain(base: string, relativePath: string): boolean {
  return pathChainChecker(base)(relativePath);
}

/**
 * safePathChain for many paths under one base in one synchronous pass, with
 * the same verdict per path. Every component below the base is lstat'ed and
 * must not be a link, so its real path is the base's real path plus the
 * components walked: the base is resolved once, not once per component, and a
 * directory several paths share is examined once. That per-component walk
 * from the drive root made each file of a rollback cost thousands of syscalls.
 * Hold the checker for one pass only, never across an await or a write.
 * `knownRealRoot` is the base's real path when the caller resolved it in the
 * same pass (directoryIdentity's `real`).
 */
export function pathChainChecker(base: string, knownRealRoot?: string): (relativePath: string) => boolean {
  const root = resolve(base);
  let realRoot = knownRealRoot;
  const components = new Map<string, "safe" | "missing" | "unsafe">();
  const examine = (current: string): "safe" | "missing" | "unsafe" => {
    try {
      if (lstatSync(current).isSymbolicLink()) return "unsafe";
      realRoot ??= realpathSync(root);
      return inside(base, resolve(realRoot, relative(root, current))) ? "safe" : "unsafe";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
    }
  };
  return (relativePath) => {
    if (!safeRelative(relativePath) || !inside(base, resolve(base, relativePath))) return false;
    let current = root;
    for (const part of relativePath.split(/[\\/]/)) {
      current = resolve(current, part);
      let verdict = components.get(current);
      if (verdict === undefined) components.set(current, verdict = examine(current));
      if (verdict === "unsafe") return false;
    }
    return true;
  };
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
  return { ...unsigned, manifestCommitment: hash(journalManifest(unsigned)) };
}
