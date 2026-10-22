// Where a chat's file-read record waits out a server restart. read-state.ts
// owns the record; this keeps only its edit-gate part on disk (the content hash
// the chat last saw, the disk mtime, the hash an external change was already
// reported at), so a chat that read a file before LAX restarted can still edit
// it afterwards. Snapshots stay in memory: they are file contents, and a diff of
// a change made while LAX was down has no honest "before" anyway.
//
// Live failure (chat-mvfaq00w, 2026-10-21): the server restarted 23 s before the
// user said "DO IT"; the edit of a file the chat had read 4.5 h earlier was
// refused with "this session hasn't read it", and the model spent a round
// re-reading it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync, ensureDirFor } from "../util/json-store.js";
import { createLogger } from "../logger.js";

const logger = createLogger("read-state-store");

export interface StoredRead {
  hash: string;
  mtimeMs: number;
  notifiedHash?: string;
}

function storePath(sessionId: string): string {
  const name = /^[A-Za-z0-9_-]{1,80}$/.test(sessionId)
    ? sessionId
    : createHash("sha1").update(sessionId).digest("hex");
  return join(getLaxDir(), "read-state", `${name}.json`);
}

/** The reads a previous server run recorded for `sessionId`; empty when none. */
export function loadStoredReads(sessionId: string): Map<string, StoredRead> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(storePath(sessionId), "utf-8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`read record for ${sessionId} unreadable — starting empty: ${(e as Error).message}`);
    }
    return new Map();
  }
  const out = new Map<string, StoredRead>();
  if (!raw || typeof raw !== "object") return out;
  for (const [path, e] of Object.entries(raw as Record<string, Partial<StoredRead>>)) {
    if (typeof e?.hash !== "string" || typeof e.mtimeMs !== "number") continue;
    out.set(path, { hash: e.hash, mtimeMs: e.mtimeMs, ...(typeof e.notifiedHash === "string" ? { notifiedHash: e.notifiedHash } : {}) });
  }
  return out;
}

/** Replace `sessionId`'s stored reads. A failed write costs only a re-read
 *  after the next restart, so it is logged, never thrown into the tool call. */
export function saveStoredReads(sessionId: string, reads: Iterable<[string, StoredRead]>): void {
  const out: Record<string, StoredRead> = {};
  for (const [path, e] of reads) {
    out[path] = e.notifiedHash ? { hash: e.hash, mtimeMs: e.mtimeMs, notifiedHash: e.notifiedHash } : { hash: e.hash, mtimeMs: e.mtimeMs };
  }
  const file = storePath(sessionId);
  try {
    ensureDirFor(file);
    atomicWriteFileSync(file, JSON.stringify(out));
  } catch (e) {
    logger.warn(`read record for ${sessionId} not saved: ${(e as Error).message}`);
  }
}
