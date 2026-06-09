// Per-session file-freshness tracking for the stale-read guard.
//
// An edit that targets a file the session hasn't read since it last changed on
// disk is editing against a stale mental model — the classic source of silent
// clobbers and "my edit matched the wrong place because the file already moved
// on." We record a content hash whenever a session reads or writes a file, and
// the edit family checks the on-disk hash against the last one this session saw
// before touching it: divergence (or never having read it) means "re-read
// first", not a blind write.
//
// Hash, not mtime: mtime is coarse, survives content-preserving touches, and
// jumps on no-op rewrites. A content hash is exact and cheap at the file sizes
// the edit tools handle. This is deliberately NOT the data-lineage taint map —
// that tracks sensitive-byte provenance for egress; this tracks "did this
// session see the current bytes." Different question, different lifetime.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

const seen = new Map<string, Map<string, string>>(); // sessionId -> (path -> hash)

function sid(sessionId: string | undefined): string {
  return sessionId || "default";
}

function hash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function diskHash(path: string): string | null {
  try {
    return existsSync(path) ? hash(readFileSync(path, "utf-8")) : null;
  } catch {
    return null;
  }
}

/** Record that `sessionId` has seen the current on-disk bytes of `path`.
 *  Called after a successful read or write. No-op if the file can't be read. */
export function recordFileSeen(sessionId: string | undefined, path: string): void {
  const h = diskHash(path);
  if (h === null) return;
  let m = seen.get(sid(sessionId));
  if (!m) { m = new Map(); seen.set(sid(sessionId), m); }
  m.set(path, h);
}

export type Freshness = "ok" | "stale" | "unseen";

/** Whether `sessionId` may edit `path` without re-reading.
 *  - unseen: never read/written this file this session
 *  - stale:  on-disk content changed since this session last saw it
 *  - ok:     this session has seen the current bytes */
export function checkFreshness(sessionId: string | undefined, path: string): Freshness {
  const known = seen.get(sid(sessionId))?.get(path);
  if (known === undefined) return "unseen";
  const current = diskHash(path);
  if (current === null) return "ok"; // missing file is the edit tool's problem to report, not ours
  return current === known ? "ok" : "stale";
}

/** Drop a session's tracking (call on session end to bound the map). */
export function forgetSessionReads(sessionId: string): void {
  seen.delete(sid(sessionId));
}
