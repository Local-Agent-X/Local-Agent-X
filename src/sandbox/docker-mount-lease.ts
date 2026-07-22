import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { DockerBindMount } from "./docker-execution-runtime.js";

interface HeldMountRoot { configuredPath: string; fd: number }

export function holdValidatedMounts(
  mounts: readonly DockerBindMount[],
  approvedMountRoots: readonly string[],
): { mounts: DockerBindMount[]; close: () => void } {
  if (mounts.length > 0 && process.platform !== "linux") {
    throw new Error("inode-stable container bind mounts require a Linux host");
  }
  const descriptors: number[] = [];
  try {
    const roots = mounts.length > 0
      ? approvedMountRoots.map(root => holdDirectory(resolve(root), descriptors))
      : [];
    const held = mounts.map(mount => {
      validateMountShape(mount);
      const source = resolve(mount.source);
      if (mount.target === "/var/run/docker.sock" || dockerSocketPath(source)) {
        throw new Error("Docker socket mount is forbidden");
      }
      const fd = holdMountBelowRoot(source, roots, descriptors);
      const identity = fstatSync(fd);
      if (!identity.isFile() && !identity.isDirectory()) {
        throw new Error("container execution mount source must be a regular file or directory");
      }
      if (mount.identity) {
        const exact = fstatSync(fd, { bigint: true });
        if (exact.dev.toString() !== mount.identity.device || exact.ino.toString() !== mount.identity.inode) {
          throw new Error("container execution mount source identity changed");
        }
      }
      return { ...mount, source: fdPath(fd) };
    });
    return { mounts: held, close: () => closeAll(descriptors) };
  } catch (error) {
    closeAll(descriptors);
    throw error;
  }
}

export function validateMountShape(mount: DockerBindMount): void {
  if (!mount.source || !/^\/[A-Za-z0-9._/-]+$/.test(mount.target)
    || mount.target === "/" || mount.source.includes("\0") || mount.target.includes("..")) {
    throw new Error("invalid container execution mount");
  }
  if (mount.target === "/var/run/docker.sock" || dockerSocketPath(resolve(mount.source))) {
    throw new Error("Docker socket mount is forbidden");
  }
  if (mount.identity && (!/^\d+$/.test(mount.identity.device) || !/^\d+$/.test(mount.identity.inode))) {
    throw new Error("invalid container execution mount identity");
  }
}

function holdDirectory(path: string, descriptors: number[]): HeldMountRoot {
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch { throw new Error("approved container mount root is unavailable"); }
  const before = lstatSync(canonical);
  if (!before.isDirectory()) throw new Error("approved container mount root is unavailable");
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
  descriptors.push(fd);
  const held = fstatSync(fd);
  if (!held.isDirectory() || before.dev !== held.dev || before.ino !== held.ino) {
    throw new Error("approved container mount root identity changed");
  }
  return { configuredPath: path, fd };
}

function holdMountBelowRoot(source: string, roots: readonly HeldMountRoot[], descriptors: number[]): number {
  const root = roots
    .filter(candidate => source === candidate.configuredPath
      || source.startsWith(candidate.configuredPath.endsWith(sep)
        ? candidate.configuredPath : candidate.configuredPath + sep))
    .sort((left, right) => right.configuredPath.length - left.configuredPath.length)[0];
  if (!root) throw new Error("container execution mount source is outside approved roots");
  const parts = relative(root.configuredPath, source).split(sep).filter(Boolean);
  let fd = root.fd;
  try {
    for (const [index, part] of parts.entries()) {
      const directoryFlag = index < parts.length - 1 ? constants.O_DIRECTORY : 0;
      fd = openSync(`${fdPath(fd)}/${part}`, constants.O_RDONLY | directoryFlag | (constants.O_NOFOLLOW ?? 0));
      descriptors.push(fd);
      if (index < parts.length - 1 && !fstatSync(fd).isDirectory()) {
        throw new Error("container execution mount path component is not a directory");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("container execution")) throw error;
    throw new Error("container execution mount source is unavailable");
  }
  return fd;
}

function fdPath(fd: number): string {
  return `/proc/${process.pid}/fd/${fd}`;
}

function closeAll(descriptors: number[]): void {
  for (const fd of descriptors.splice(0)) closeSync(fd);
}

function dockerSocketPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().endsWith("/docker.sock");
}
