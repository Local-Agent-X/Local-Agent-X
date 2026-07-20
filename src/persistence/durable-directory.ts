import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
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
