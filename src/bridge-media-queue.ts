import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { opDir } from "./ops/event-log.js";
import { ensureDurableDirectory, fsyncDirectory } from "./persistence/durable-directory.js";

export type PendingMedia = { images: Buffer[]; imagePaths: string[]; videoPaths: string[] };
type StoredMedia = { schemaVersion: 1; images: string[]; imagePaths: string[]; videoPaths: string[] };

const queue = new Map<string, PendingMedia>();
const MAX_OPS = 64;

export function enqueueBridgeMedia(
  opId: string,
  media: { imageB64?: string[]; imagePath?: string; videoPath?: string },
): void {
  if (!opId) return;
  let pending = queue.get(opId);
  if (!pending) {
    if (queue.size >= MAX_OPS) {
      const oldest = queue.keys().next().value;
      if (oldest !== undefined) queue.delete(oldest);
    }
    pending = { images: [], imagePaths: [], videoPaths: [] };
    queue.set(opId, pending);
  }
  for (const b64 of media.imageB64 ?? []) {
    try { pending.images.push(Buffer.from(b64, "base64")); } catch {}
  }
  if (media.imagePath) pending.imagePaths.push(media.imagePath);
  if (media.videoPath) pending.videoPaths.push(media.videoPath);
  checkpointBridgeMedia(opId, pending);
}

function mediaPath(opId: string): string {
  return join(opDir(opId), "bridge-media.json");
}

export function persistBridgeMedia(opId: string): void {
  const pending = queue.get(opId);
  if (pending) checkpointBridgeMedia(opId, pending);
}

export function readBridgeMedia(opId: string): PendingMedia | null {
  const memory = queue.get(opId);
  if (memory) return clone(memory);
  const path = mediaPath(opId);
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredMedia;
    if (stored.schemaVersion !== 1) return null;
    const pending = {
      images: stored.images.map((image) => Buffer.from(image, "base64")),
      imagePaths: stored.imagePaths,
      videoPaths: stored.videoPaths,
    };
    queue.set(opId, pending);
    return clone(pending);
  } catch {
    return null;
  }
}

export function checkpointBridgeMedia(opId: string, pending: PendingMedia): void {
  const path = mediaPath(opId);
  if (pending.images.length === 0 && pending.imagePaths.length === 0 && pending.videoPaths.length === 0) {
    queue.delete(opId);
    rmSync(path, { force: true });
    return;
  }
  const dir = opDir(opId);
  ensureDurableDirectory(dir);
  const next = clone(pending);
  queue.set(opId, next);
  const stage = `${path}.${process.pid}-${randomUUID()}.stage`;
  const bytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    images: next.images.map((image) => image.toString("base64")),
    imagePaths: next.imagePaths,
    videoPaths: next.videoPaths,
  } satisfies StoredMedia));
  const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("bridge media checkpoint write made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(stage, path);
  fsyncDirectory(dir);
}

function clone(pending: PendingMedia): PendingMedia {
  return { images: [...pending.images], imagePaths: [...pending.imagePaths], videoPaths: [...pending.videoPaths] };
}
