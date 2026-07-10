/**
 * Atomic, symlink-safe write for on-disk secrets (OAuth token stores).
 *
 * The provider and CLI auth writers (LAX envelopes plus Codex/Claude CLI
 * files) previously hand-rolled the same
 * `writeFileSync(`${path}.tmp`, …, {mode:0o600})` + `renameSync` dance. `mode`
 * only applies when open() *creates* the inode — so a pre-planted
 * `auth.json.tmp` symlink redirects the write to wherever the attacker points,
 * and the secret lands outside the 0600 file we thought we wrote. Bounded
 * (same-user) but a malicious npm dep can stage the redirect before the token
 * is saved.
 *
 * This primitive opens the temp path with `O_CREAT|O_EXCL|O_WRONLY` (+
 * `O_NOFOLLOW` where the platform has it): O_EXCL makes open() fail if the
 * temp path already exists — including as a symlink — so a pre-staged redirect
 * is refused, not followed. A leftover *regular* temp file from a crashed write
 * is cleared and retried once (the legitimate stale-tmp case); a leftover
 * *symlink* is treated as an attack and throws. fsync before rename so the
 * bytes are durable. On any failure the temp is unlinked best-effort.
 */
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync,
  lstatSync, unlinkSync, existsSync, constants,
} from "node:fs";

const SECRET_MODE = 0o600;
// O_NOFOLLOW is POSIX-only; libuv leaves it undefined on Windows. O_EXCL is the
// real guard (refuses a pre-existing temp path of any kind); NOFOLLOW is
// belt-and-suspenders on the create.
const WRITE_FLAGS =
  constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);

export interface SecretFileOps {
  open: typeof openSync;
  write: typeof writeSync;
  fsync: typeof fsyncSync;
  close: typeof closeSync;
  rename: typeof renameSync;
  lstat: typeof lstatSync;
  unlink: typeof unlinkSync;
  exists: typeof existsSync;
}

const DEFAULT_OPS: SecretFileOps = {
  open: openSync,
  write: writeSync,
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  lstat: lstatSync,
  unlink: unlinkSync,
  exists: existsSync,
};

function writeSecretFileAtomicWithOps(targetPath: string, data: string, ops: SecretFileOps): void {
  const tmp = `${targetPath}.tmp`;
  let fd: number;
  try {
    fd = ops.open(tmp, WRITE_FLAGS, SECRET_MODE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Temp path already exists. A symlink is a redirect attack — refuse it.
    // A stale regular file is a crashed-write leftover — clear it and retry.
    if (ops.lstat(tmp).isSymbolicLink()) {
      throw new Error(`writeSecretFileAtomic: refusing to write through symlinked temp path ${tmp}`);
    }
    ops.unlink(tmp);
    fd = ops.open(tmp, WRITE_FLAGS, SECRET_MODE);
  }

  let failure: unknown;
  try {
    const bytes = Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      const written = ops.write(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("writeSecretFileAtomic: write made no progress");
      offset += written;
    }
    ops.fsync(fd);
  } catch (e) {
    failure = e;
  } finally {
    try { ops.close(fd); } catch (e) { failure ??= e; }
  }
  if (failure) {
    try { if (ops.exists(tmp)) ops.unlink(tmp); } catch { /* preserve the primary failure */ }
    throw failure;
  }
  try {
    ops.rename(tmp, targetPath);
  } catch (e) {
    try { if (ops.exists(tmp)) ops.unlink(tmp); } catch { /* preserve the rename failure */ }
    throw e;
  }
}

export function writeSecretFileAtomic(targetPath: string, data: string): void {
  writeSecretFileAtomicWithOps(targetPath, data, DEFAULT_OPS);
}

export function _writeSecretFileAtomicForTests(
  targetPath: string,
  data: string,
  overrides: Partial<SecretFileOps>,
): void {
  writeSecretFileAtomicWithOps(targetPath, data, { ...DEFAULT_OPS, ...overrides });
}
