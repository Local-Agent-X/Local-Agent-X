import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

let syncHook: ((path: string) => void) | null = null;

export function _setDirectorySyncHookForTests(hook: ((path: string) => void) | null): void {
  syncHook = hook;
}

/** Create a directory hierarchy and durably publish every new directory entry
 * by syncing its parent from shallowest to deepest. */
export function ensureDurableDirectory(path: string): boolean {
  const target = resolve(path);
  if (existsSync(target)) return false;
  const missing: string[] = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (let index = missing.length - 1; index >= 0; index--) {
    fsyncDirectory(dirname(missing[index]));
  }
  return true;
}

export function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not expose portable directory fsync. Only its known
    // unsupported-handle errors degrade; POSIX and all other errors surface.
    const windowsUnsupported = process.platform === "win32"
      && ["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "");
    if (!windowsUnsupported) throw error;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* preserve primary failure */ }
  }
  syncHook?.(resolve(path));
}

/** Replace `path` with `content` so a crash leaves the old file or the new
 *  one, never a torn write: written and fsynced under a private name
 *  (`<path>.<pid>.<uuid>.tmp`, which crash repair recognizes), renamed into
 *  place, and the rename published by syncing the folder. */
export function writeFileDurably(path: string, content: string): void {
  ensureDurableDirectory(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDirectory(dirname(path));
}
