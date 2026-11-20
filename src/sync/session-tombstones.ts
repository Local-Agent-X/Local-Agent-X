/**
 * Erased-chat tombstones: a chat the user erased stays erased on every
 * machine that syncs.
 *
 * Session sync copies a log in whenever the mirror has one this machine lacks
 * (pull-files/pull-misc.ts) and never removes a mirror copy (push-sessions.ts),
 * so without a record an erased chat came back on the next pull, from the
 * mirror or from another machine's push.
 *
 * One store, synced: `sync-repo/.tombstones/sessions/<id>.json` holding when
 * the chat was erased. Writing it also removes the mirror's copy of the log, so
 * the next push commits the removal. A log is the erased chat when it was
 * created no later than the erase: a WhatsApp or Telegram chat keeps its id, so
 * its next message starts a new log under the same id, and that one syncs.
 *   - pull skips an erased copy and reports the local ones to erase
 *     (erasedLocalSessionIds), which the server erases like the user did;
 *   - push leaves an erased copy out of the mirror.
 * Written whether or not sync is on: the file waits in the repo until it is.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { readSessionLogRows, sessionLogMeta } from "../memory/session-log-rows.js";

interface SessionTombstone {
  id: string;
  /** Epoch ms. */
  erasedAt: number;
  machine: string;
}

function tombstoneDir(syncDir: string): string {
  return join(syncDir, ".tombstones", "sessions");
}

/** Record that session `id` was erased now, and drop the mirror's copy of its log. */
export function tombstoneErasedSession(syncDir: string, id: string, now = Date.now()): void {
  const dir = tombstoneDir(syncDir);
  mkdirSync(dir, { recursive: true });
  const tombstone: SessionTombstone = { id, erasedAt: now, machine: hostname() };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(tombstone, null, 2), "utf-8");
  for (const ext of [".jsonl", ".json"]) {
    const mirrored = join(syncDir, "sessions", `${id}${ext}`);
    if (existsSync(mirrored)) unlinkSync(mirrored);
  }
}

/** Erase time by session id, from every machine's tombstones. */
export function erasedSessions(syncDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const dir = tombstoneDir(syncDir);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf-8")) as SessionTombstone;
      if (typeof t.id === "string" && typeof t.erasedAt === "number") out.set(t.id, t.erasedAt);
    } catch { /* a malformed tombstone erases nothing */ }
  }
  return out;
}

/** Whether the log at `path` (session `id`) is a copy of a chat that was erased. */
export function isErasedCopy(path: string, id: string, erased: ReadonlyMap<string, number>): boolean {
  const erasedAt = erased.get(id);
  if (erasedAt === undefined) return false;
  if (!path.endsWith(".jsonl")) return true; // a legacy blob predates any erase
  const createdAt = sessionLogMeta(readSessionLogRows(path) ?? [])?.createdAt;
  return createdAt === undefined || createdAt <= erasedAt;
}

/** Ids whose log on this machine, live or archived, is a copy of an erased chat. */
export function erasedLocalSessionIds(dataDir: string, syncDir: string): string[] {
  const erased = erasedSessions(syncDir);
  const out: string[] = [];
  for (const id of erased.keys()) {
    const copies = [join(dataDir, "sessions", `${id}.jsonl`), join(dataDir, "sessions-archive", `${id}.jsonl`)];
    if (copies.some((p) => existsSync(p) && isErasedCopy(p, id, erased))) out.push(id);
  }
  return out;
}
