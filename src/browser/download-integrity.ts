import { constants, createWriteStream } from "node:fs";
import { link, lstat, open, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export interface ReleaseIdentity {
  digest: string;
  size: number;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size;
}

async function openRegularNoFollow(path: string): Promise<{ handle: FileHandle; initial: Stats }> {
  const initial = await lstat(path);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("Quarantined download is not a regular file.");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  const opened = await handle.stat();
  if (!opened.isFile() || !sameFile(initial, opened)) {
    await handle.close();
    throw new Error("Quarantined download changed while it was being opened.");
  }
  return { handle, initial };
}

async function digestHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function candidatePath(dir: string, filename: string, n: number): string {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return join(dir, n === 1 ? filename : `${stem}-${n}${ext}`);
}

async function copyPinned(handle: FileHandle, partial: string): Promise<string> {
  const out = createWriteStream(partial, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  try {
    for await (const raw of handle.createReadStream({ start: 0, autoClose: false })) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((resolveDrain) => out.once("drain", resolveDrain));
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.once("finish", resolveEnd);
      out.once("error", rejectEnd);
      out.end();
    });
    return hash.digest("hex");
  } catch (error) {
    if (!out.closed) {
      await new Promise<void>((resolveClose) => {
        out.once("close", resolveClose);
        out.destroy();
      });
    }
    throw error;
  }
}

export async function publishVerifiedDownload(
  quarantinePath: string,
  releaseDir: string,
  filename: string,
  expected: ReleaseIdentity,
): Promise<string> {
  const { handle, initial } = await openRegularNoFollow(quarantinePath);
  const partial = join(releaseDir, `.${filename}.${Math.random().toString(16).slice(2)}.partial`);
  try {
    const digest = await digestHandle(handle);
    const beforeCopy = await handle.stat();
    if (beforeCopy.size !== expected.size || digest !== expected.digest || !sameFile(initial, beforeCopy)) {
      throw new Error("Quarantined download digest or size changed before release.");
    }
    const copiedDigest = await copyPinned(handle, partial);
    const afterCopy = await handle.stat();
    if (copiedDigest !== expected.digest || afterCopy.size !== expected.size || !sameFile(initial, afterCopy)) {
      throw new Error("Quarantined download changed during release.");
    }
    let destination = "";
    let published = false;
    for (let n = 1; n < 1000; n++) {
      try {
        destination = candidatePath(releaseDir, filename, n);
        await link(partial, destination);
        published = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!published) throw new Error("Could not allocate a unique release filename.");
    await unlink(partial).catch(() => { /* published hard link owns the complete bytes */ });
    const current = await lstat(quarantinePath).catch(() => null);
    if (current && !current.isSymbolicLink() && sameFile(initial, current)) await unlink(quarantinePath).catch(() => { /* stale quarantine cleanup can retry later */ });
    return destination;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
