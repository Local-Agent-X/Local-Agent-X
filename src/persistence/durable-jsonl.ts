import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDurableDirectory, fsyncDirectory } from "./durable-directory.js";
import { currentProcessIncarnation, processAlive } from "./process-incarnation.js";

const LOCK_STALE_MS = 2_000;
const LOCK_WAIT_MS = 500;
const RETRY_MS = 10;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const held = new Set<string>();
export type DurableJsonlLockPoint = "before_publish" | "after_acquire" | "after_reclaim_observe";
let lockHook: ((point: DurableJsonlLockPoint, path: string) => void) | null = null;

export function _setDurableJsonlLockHookForTests(
  hook: ((point: DurableJsonlLockPoint, path: string) => void) | null,
): void {
  lockHook = hook;
}

export interface DurableJsonlAppend<T> {
  rows: T[];
  value: T | null;
  appended: boolean;
}

/** Repair a torn/invalid tail, derive the next row from valid frames, append,
 * and fsync. The adjacent lock serializes files shared by multiple op locks. */
export function updateDurableJsonl<T>(
  path: string,
  validate: (value: unknown) => value is T,
  build: (rows: readonly T[]) => T | null,
): DurableJsonlAppend<T> {
  return withJsonlLock(path, () => {
    const rows = repairAndRead(path, validate);
    const value = build(rows);
    if (!value) return { rows, value: null, appended: false };
    appendAndSync(path, JSON.stringify(value) + "\n");
    return { rows: [...rows, value], value, appended: true };
  });
}

export function readDurableJsonl<T>(
  path: string,
  validate: (value: unknown) => value is T,
): T[] {
  if (!existsSync(path)) return [];
  return withJsonlLock(path, () => repairAndRead(path, validate));
}

/** Fast path after a caller verified file size against a repaired, fsynced
 * cache while holding its own authority lock. */
export function appendKnownGoodJsonl(path: string, value: unknown): void {
  withJsonlLock(path, () => appendAndSync(path, JSON.stringify(value) + "\n"));
}

function repairAndRead<T>(path: string, validate: (value: unknown) => value is T): T[] {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  const rows: T[] = [];
  let frameStart = 0;
  let validBytes = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    const text = bytes.subarray(frameStart, i).toString("utf-8").trim();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!validate(parsed)) break;
        rows.push(parsed);
      } catch { break; }
    }
    validBytes = i + 1;
    frameStart = i + 1;
  }
  if (validBytes !== bytes.length) {
    truncateSync(path, validBytes);
    const fd = openSync(path, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return rows;
}

function appendAndSync(path: string, line: string): void {
  ensureDurableDirectory(dirname(path));
  const created = !existsSync(path);
  const fd = openSync(path, "a", 0o600);
  try {
    const bytes = Buffer.from(line);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("durable JSONL append made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (created) fsyncDirectory(dirname(path));
}

function withJsonlLock<T>(path: string, fn: () => T): T {
  if (held.has(path)) return fn();
  ensureDurableDirectory(dirname(path));
  const lock = `${path}.lock`;
  const token = randomUUID();
  // Read before the wait starts: a process's first incarnation read can take a second.
  const owner = JSON.stringify({ pid: process.pid, incarnation: currentProcessIncarnation() });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryAcquire(lock, token, owner)) { lockHook?.("after_acquire", path); break; }
    if (reclaimDeadLock(lock)) continue;
    if (Date.now() >= deadline) throw new Error(`durable JSONL lock timeout: ${path}`);
    Atomics.wait(sleeper, 0, 0, RETRY_MS);
  }
  held.add(path);
  try { return fn(); }
  finally {
    held.delete(path);
    try { rmSync(join(lock, token), { force: true }); } catch { /* no longer ours */ }
    try { rmdirSync(lock); } catch { /* another token remains */ }
  }
}

// A lock folder appears already holding its owner's token: it is built under a
// private name and renamed into place. Made in place (mkdir, then write the
// token), it stood empty for a moment, and a reclaimer's rmdir of the stale
// lock could delete it; the owner then wrote its token into the next taker's
// folder and both held the lock (Windows CI, 2026-11-15).
const LOCK_HELD_CODES = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"]);

function tryAcquire(lock: string, token: string, owner: string): boolean {
  const staged = `${lock}.${token}`;
  mkdirSync(staged, { mode: 0o700 });
  try {
    writeFileSync(join(staged, token), owner, { flag: "wx", mode: 0o600 });
    lockHook?.("before_publish", lock);
    renameSync(staged, lock);
    return true;
  } catch (error) {
    if (!existsSync(lock) && !LOCK_HELD_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  } finally {
    // Gone once renamed; otherwise ours to clear.
    rmSync(staged, { recursive: true, force: true });
  }
}

function reclaimDeadLock(lock: string): boolean {
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return true; }
  if (age <= LOCK_STALE_MS) return false;
  let names: string[];
  try { names = readdirSync(lock); } catch { return false; }
  for (const name of names) {
    try {
      const owner = JSON.parse(readFileSync(join(lock, name), "utf-8")) as { pid?: unknown; incarnation?: unknown };
      const incarnation = typeof owner.incarnation === "string" ? owner.incarnation : undefined;
      if (typeof owner.pid === "number" && processAlive(owner.pid, incarnation)) return false;
    } catch { /* malformed stale owner is reclaimable */ }
  }
  lockHook?.("after_reclaim_observe", lock);
  for (const name of names) {
    try { rmSync(join(lock, name), { force: true }); } catch { return false; }
  }
  // Token-safe reclaim: a replacement may create a fresh token after our
  // observation. rmdir then fails and we never recursively erase its claim.
  try { rmdirSync(lock); return true; }
  catch { return false; }
}
