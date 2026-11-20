import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createLogger } from "../logger.js";
import { sessionLogIsAhead } from "./session-log-ahead.js";
import { erasedSessions, isErasedCopy } from "./session-tombstones.js";

const logger = createLogger("sync.push-sessions");

// A session log this big is a runaway, not real history (a memory_dream
// session hit 150 MB). Syncing it blows the push pack past git's timeout and
// jams the whole sync, so it's excluded rather than allowed to wedge backups.
const MAX_SESSION_SYNC_BYTES = 10 * 1024 * 1024;

// ── Which session logs a push writes into the mirror ──
//
// Only the ones this machine changed since its last push. Two machines can
// hold the same chat in copies that differ without either being ahead: the
// one-time time repair (memory/session-time-backfill.ts) ran on each
// machine's copy and gave id-less rows a random id and whatever time that
// machine's op records knew. Writing the local copy over the mirror's on every
// push made each machine put its own back: 2,300 chats, about 7 MB, flipped
// every time sync passed from one machine to the other (2026-11-13). Pull
// already keeps a local copy unless the mirror's is ahead; this is the same
// rule in the push direction.
//
// The record (sync-state/pushed-sessions.json) holds each log's mtime when it
// was last written into the mirror, or seen and left. A log with no entry —
// every log, the first time — goes in only when the mirror lacks it or the
// local copy is ahead (session-log-ahead.ts).

function recordFile(dataDir: string): string {
  return join(dataDir, "sync-state", "pushed-sessions.json");
}

function readRecord(dataDir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(recordFile(dataDir), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    // No record yet, or an unreadable one: each log is judged on its contents.
    return {};
  }
}

/** Whether `src` goes into the mirror at `dest`. */
function belongsInMirror(src: string, dest: string, mtimeMs: number, recorded: number | undefined): boolean {
  if (!existsSync(dest)) return true;
  if (recorded !== undefined) return mtimeMs !== recorded;
  return sessionLogIsAhead(src, dest);
}

export async function pushSessions(dataDir: string, syncDir: string): Promise<void> {
  const sessDir = join(dataDir, "sessions");
  const syncSessDir = join(syncDir, "sessions");
  if (!existsSync(syncSessDir)) mkdirSync(syncSessDir, { recursive: true });
  if (!existsSync(sessDir)) return;
  const before = readRecord(dataDir);
  const after: Record<string, number> = {};
  const erased = erasedSessions(syncDir);
  let unrecorded = 0;
  for (const f of readdirSync(sessDir)) {
    // Sync both .jsonl (current) and .json (legacy/pre-migration) so
    // round-tripping a sync from an older machine still works. The
    // `.metadata.*` dotfiles are this machine's list cache, not sessions.
    if (f.startsWith(".") || (!f.endsWith(".jsonl") && !f.endsWith(".json"))) continue;
    const src = join(sessDir, f);
    const st = statSync(src);
    // Hard size cap. A single runaway log (a 150 MB memory_dream session
    // was the real one) bloats the push pack past the git timeout, so
    // every push fails, commits strand, and the whole sync wedges. One
    // pathological file must never be able to brick all of sync — skip it.
    if (st.size > MAX_SESSION_SYNC_BYTES) {
      logger.warn(`[sync] skipping oversized session ${f} (${(st.size / 1048576).toFixed(0)} MB > ${MAX_SESSION_SYNC_BYTES / 1048576} MB cap)`);
      continue;
    }
    // A copy of a chat erased on any machine stays out of the mirror (session-tombstones.ts).
    if (isErasedCopy(src, f.replace(/\.jsonl?$/, ""), erased)) continue;
    const dest = join(syncSessDir, f);
    if (before[f] === undefined) {
      // Comparing contents reads both copies: hand the thread back between
      // them so a first run over thousands of logs does not hold it.
      unrecorded++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (belongsInMirror(src, dest, st.mtimeMs, before[f])) writeFileSync(dest, readFileSync(src));
    after[f] = st.mtimeMs;
  }
  if (unrecorded > 0) logger.info(`[sync] judged ${unrecorded} session log(s) with no push record by their contents`);
  mkdirSync(dirname(recordFile(dataDir)), { recursive: true });
  writeFileSync(recordFile(dataDir), JSON.stringify(after), "utf-8");
}
