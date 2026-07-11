// Per-session file read-state: the stale-read guard, read-dedup, and the
// external-change sweep all key off this one map.
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
//
// On top of the hash, each entry keeps the view shape (partial/range), the
// disk mtime (a cheap prefilter — NEVER the decider), and a bounded full-file
// snapshot. The snapshot powers two things:
//   - read-dedup: an identical full re-read returns a one-line stub upstream
//     (run-sandboxed) instead of re-shipping bytes the session already holds;
//   - external-change diffs: the snapshot captured AT READ TIME is the only
//     honest "before" for a diff against current disk (a baseline is
//     unknowable later — same reasoning as post-edit-diagnostics' baselines).
// Only the snapshots are LRU-bounded; the hash entries stay for the session's
// lifetime because the stale-read EDIT GATE must never forget a file it has
// seen (an evicted hash would re-block edits on long multi-file sessions).

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { realpathDeep } from "../security/layer/index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("read-state");

/** Content snapshots kept per session (LRU on last-seen; hash entries are
 *  never evicted by this cap — only the heavy diff/dedup snapshot is). */
const MAX_SNAPSHOTS_PER_SESSION = 64;
/** Files above this skip the snapshot: an external change then surfaces as a
 *  "changed, re-read it" notice without a diff, which is the honest degrade. */
const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** Consecutive ENOENT sweeps before an entry is evicted as definitively gone.
 *  A single miss can be an editor atomic-save delete→rename race. */
const ENOENT_SWEEPS_TO_EVICT = 2;

/** How a session saw a file when it was recorded. */
export interface SeenView {
  /** True when the session saw only PART of the file — a range-clipped read of
   *  a large file, or a screened view (injection warning prepended). Partial
   *  views never dedup: the next read must return real content. */
  partial: boolean;
  /** The requested read range, when the caller passed one. Informational —
   *  dedup keys on `partial`, not on range equality. */
  range?: { offset?: number; limit?: number };
  /** True when the model's sight of the file was REDACTED (data-lineage stub:
   *  the tool call succeeded but the bytes were withheld). Hash-only state is
   *  recorded: NO content snapshot — an external-change diff would otherwise
   *  leak the real bytes into model context through the nudge — and the view
   *  never dedups (the model holds a placeholder, not a current view). */
  redacted?: boolean;
}

interface SeenEntry {
  /** sha1 of the on-disk bytes when this session last saw the file. The
   *  stale-read edit gate compares against THIS — semantics unchanged. */
  hash: string;
  /** Disk mtime at record time. Sweep/dedup prefilter only, never the decider
   *  (atomic saves bump mtime on identical bytes). */
  mtimeMs: number;
  /** Full-file snapshot for external-change diffs. Absent when the file
   *  exceeds MAX_SNAPSHOT_BYTES or the per-session snapshot LRU dropped it. */
  content?: string;
  partial: boolean;
  range?: SeenView["range"];
  lastSeenAt: number;
  /** Disk hash of an external change already surfaced to the model as a
   *  truncated/diff-less notice. Suppresses re-notification WITHOUT moving the
   *  edit-gate baseline — the model hasn't seen the full new bytes. */
  notifiedHash?: string;
  /** Consecutive sweeps whose stat came back ENOENT. */
  missingSweeps: number;
}

const seen = new Map<string, Map<string, SeenEntry>>(); // sessionId -> (canonical path -> entry)

function sid(sessionId: string | undefined): string {
  return sessionId || "default";
}

// Key the freshness map by the CANONICAL path — following junctions/symlinks at
// every existing segment via the SAME resolver the security gate and file tools
// use. Without this, a read and a later edit of ONE physical file can land under
// two different keys when the paths spell the same inode differently: the
// workspace junction (…\local-agent-x\workspace\…) vs its target
// (…\Documents\Local Agent X\workspace\…). The edit then reads as "unseen",
// the stale-read guard blocks it, and the worker stalls on a file it just read
// (live failure 2026-07-02, food-truck chunk 2: "wrong absolute path
// (Documents/Local Agent X vs workspace)"). Canonicalizing here collapses both
// spellings to one key, so record-on-read and check-on-edit always agree.
function canonKey(path: string): string {
  try { return realpathDeep(path); } catch { return path; }
}

function hash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

interface DiskSnapshot { content: string; hash: string; mtimeMs: number }

/** One stat+read of the current disk state. null when missing/unreadable. */
function readDisk(path: string): DiskSnapshot | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const content = readFileSync(path, "utf-8");
    return { content, hash: hash(content), mtimeMs };
  } catch {
    return null;
  }
}

/** Bound the heavy part per session: over the cap, the least-recently-seen
 *  snapshots are dropped. The entry itself (hash/mtime/view) stays, so the
 *  stale-read edit gate never forgets a file — only diff fidelity degrades to
 *  "changed on disk, no diff available". */
function evictSnapshotsOverCap(m: Map<string, SeenEntry>): void {
  const holders = [...m.values()].filter((e) => e.content !== undefined);
  if (holders.length <= MAX_SNAPSHOTS_PER_SESSION) return;
  holders.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  for (const e of holders.slice(0, holders.length - MAX_SNAPSHOTS_PER_SESSION)) {
    e.content = undefined;
  }
}

/** Record that `sessionId` has seen the current on-disk bytes of `path`.
 *  Called after a successful read or write (writes/edits pass no view: the
 *  session knows the whole resulting file). No-op if the file can't be read. */
export function recordFileSeen(sessionId: string | undefined, path: string, view?: SeenView): void {
  const disk = readDisk(path);
  if (disk === null) return;
  let m = seen.get(sid(sessionId));
  if (!m) { m = new Map(); seen.set(sid(sessionId), m); }
  const redacted = view?.redacted === true;
  m.set(canonKey(path), {
    hash: disk.hash,
    mtimeMs: disk.mtimeMs,
    // A redacted sight keeps NO snapshot: the disk bytes the model was never
    // shown must not become diff material later. The hash alone still drives
    // the edit gate and change detection (diff-less notices only).
    content: !redacted && Buffer.byteLength(disk.content) <= MAX_SNAPSHOT_BYTES ? disk.content : undefined,
    partial: redacted || (view?.partial ?? false),
    range: view?.range,
    lastSeenAt: Date.now(),
    missingSweeps: 0,
  });
  evictSnapshotsOverCap(m);
}

/** Derive the SeenView for a successful `read` result from its envelope
 *  metadata: `truncated` means offset/limit actually clipped the view,
 *  `screened` means the injection screener prepended a warning — both are
 *  partial sights of the file — and `redacted` means the data-lineage gate
 *  replaced the content with a placeholder stub (the model never saw the
 *  bytes: hash-only state, no snapshot, never dedup). Lives here so the phase
 *  layer doesn't hardcode the read tool's metadata shape. */
export function seenViewFromReadResult(
  args: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): SeenView {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const redacted = metadata?.redacted === true;
  return {
    partial: redacted || metadata?.truncated === true || metadata?.screened === true,
    range: offset !== undefined || limit !== undefined ? { offset, limit } : undefined,
    redacted,
  };
}

export type Freshness = "ok" | "stale" | "unseen";

/** Whether `sessionId` may edit `path` without re-reading.
 *  - unseen: never read/written this file this session
 *  - stale:  on-disk content changed since this session last saw it
 *  - ok:     this session has seen the current bytes */
export function checkFreshness(sessionId: string | undefined, path: string): Freshness {
  const known = seen.get(sid(sessionId))?.get(canonKey(path));
  if (known === undefined) return "unseen";
  const disk = readDisk(path);
  if (disk === null) return "ok"; // missing file is the edit tool's problem to report, not ours
  return disk.hash === known.hash ? "ok" : "stale";
}

/** Read-dedup decision: true when `path`'s CURRENT disk bytes are provably the
 *  bytes this session already saw in a FULL view. mtime is only a prefilter —
 *  a moved mtime declines the dedup without hashing (the safe direction; the
 *  real read that follows re-records), while an unchanged mtime still hashes,
 *  because the hash is the decider (mtime alone proves nothing). Partial views
 *  never dedup. A hit refreshes the entry's snapshot-LRU recency. */
export function unchangedSinceSeen(sessionId: string | undefined, path: string): boolean {
  const entry = seen.get(sid(sessionId))?.get(canonKey(path));
  if (entry === undefined || entry.partial) return false;
  try {
    if (statSync(path).mtimeMs !== entry.mtimeMs) return false;
    if (hash(readFileSync(path, "utf-8")) !== entry.hash) return false;
  } catch {
    return false; // missing/unreadable → let the real read report it
  }
  entry.lastSeenAt = Date.now();
  return true;
}

/** One file that changed on disk outside the session's own tool calls. */
export interface ExternalChange {
  /** Canonical path (the tracking key). */
  path: string;
  /** What the session last saw. undefined when the snapshot was skipped
   *  (over the byte cap) or LRU-dropped — the change is then diff-less. */
  before?: string;
  /** Current disk content. undefined whenever no diff is possible. */
  after?: string;
  /** Disk state backing this detection — resolveExternalChange adopts these. */
  diskHash: string;
  diskMtimeMs: number;
}

/** One pass over a session's tracked files: which changed on disk OUTSIDE the
 *  current turn's own tool calls (`exemptPaths` = files those calls touched)?
 *  - mtime unchanged → assumed unchanged (every real save bumps mtime; cheap).
 *  - mtime moved → hash decides: identical bytes (atomic-save touch) silently
 *    adopt the new mtime; a hash already surfaced via notifiedHash stays quiet.
 *  - ENOENT → evict only after ENOENT_SWEEPS_TO_EVICT consecutive misses.
 *  - any other stat error → logged and skipped BY POLICY, never evicted
 *    (editor atomic-save races throw transient non-ENOENT errors too).
 *  Detection does NOT move the edit-gate baseline; the caller settles each
 *  change via resolveExternalChange once it knows what the model was shown. */
export function sweepExternalChanges(
  sessionId: string | undefined,
  exemptPaths: Iterable<string> = [],
): ExternalChange[] {
  const m = seen.get(sid(sessionId));
  if (!m || m.size === 0) return [];
  const exempt = new Set<string>();
  for (const p of exemptPaths) exempt.add(canonKey(p));
  const changes: ExternalChange[] = [];
  for (const [key, entry] of m) {
    if (exempt.has(key)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(key).mtimeMs;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        entry.missingSweeps += 1;
        if (entry.missingSweeps >= ENOENT_SWEEPS_TO_EVICT) m.delete(key);
      } else {
        logger.debug(`sweep: stat ${key} failed (${code ?? "unknown"}) — skipped, not evicted (transient by policy)`);
      }
      continue;
    }
    entry.missingSweeps = 0;
    if (mtimeMs === entry.mtimeMs) continue;
    let content: string;
    try {
      content = readFileSync(key, "utf-8");
    } catch {
      continue; // race between stat and read — next sweep settles it
    }
    const diskHash = hash(content);
    if (diskHash === entry.hash) { entry.mtimeMs = mtimeMs; continue; } // no-op rewrite
    if (diskHash === entry.notifiedHash) continue; // this exact state was already surfaced
    const diffable = entry.content !== undefined && Buffer.byteLength(content) <= MAX_SNAPSHOT_BYTES;
    changes.push({
      path: key,
      before: diffable ? entry.content : undefined,
      after: diffable ? content : undefined,
      diskHash,
      diskMtimeMs: mtimeMs,
    });
  }
  return changes;
}

/** Settle a swept change once the model has been told about it.
 *  shownInFull=true (the model saw the WHOLE diff) adopts the disk state as
 *  the new baseline — hash, snapshot, mtime — so the edit gate treats the file
 *  as seen and the change never re-notifies. shownInFull=false (truncated
 *  diff / no snapshot) records only notifiedHash: re-notification stops, but
 *  the edit-gate baseline stays put, so an edit still forces a full re-read of
 *  bytes the model never actually saw. */
export function resolveExternalChange(
  sessionId: string | undefined,
  change: ExternalChange,
  shownInFull: boolean,
): void {
  const m = seen.get(sid(sessionId));
  const entry = m?.get(change.path);
  if (!m || !entry) return;
  if (shownInFull && change.after !== undefined) {
    entry.hash = change.diskHash;
    entry.mtimeMs = change.diskMtimeMs;
    entry.content = change.after;
    entry.partial = false;
    entry.range = undefined;
    entry.notifiedHash = undefined;
    entry.lastSeenAt = Date.now();
    evictSnapshotsOverCap(m);
  } else {
    entry.notifiedHash = change.diskHash;
  }
}

/** Drop a session's tracking (call on session end to bound the map). */
export function forgetSessionReads(sessionId: string): void {
  seen.delete(sid(sessionId));
}

/** Test-only: raw entry access for snapshot/counter assertions. */
export function _entryForTest(sessionId: string | undefined, path: string):
  | { hash: string; mtimeMs: number; content?: string; partial: boolean; missingSweeps: number; notifiedHash?: string }
  | undefined {
  return seen.get(sid(sessionId))?.get(canonKey(path));
}
