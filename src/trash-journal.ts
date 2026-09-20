/**
 * The delete journal: one append-only line per thing LAX trashed, recording
 * WHERE the bytes went so they can be brought back.
 *
 * The three trash tiers in safe-delete.ts each recover differently — the task
 * scope has its own manifest, the ~/.lax fallback is a plain move, and the OS
 * Recycle Bin has no machine-readable restore API at all (that last one is why
 * `restore_file` could only ever undo the agent's own files: a user's file went
 * to the bin and nothing on our side knew its name there).
 *
 * The journal is the missing half. We are the ones deleting, so we already
 * know the original absolute path at delete time; writing it down turns
 * "restore" into "move it back to the path we recorded", and reduces the
 * platform-specific part to merely FINDING the file in the OS trash.
 *
 * Append-only and best-effort by construction: a journal write must never
 * fail a delete, and a missing or corrupt line must never fail a restore. It
 * is evidence, not state.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";

const logger = createLogger("trash-journal");

/** Which tier holds the bytes, i.e. how a restore has to get them back. */
export type TrashTier =
  | "os"      // the OS Recycle Bin / Trash — per-platform lookup, no dest path of ours
  | "lax"     // ~/.lax/trash/<date>/ — `dest` is the file, a plain move restores it
  | "task"    // ~/.lax/trash/task/<sessionId>/ — restoreFromTaskTrash owns it
  | "record"; // a JSON snapshot of a config object (project, agent), not a file

export interface TrashJournalEntry {
  at: number;
  /** Absolute original path for a file; the record's name for a snapshot. */
  original: string;
  tier: TrashTier;
  /** Where the bytes are now. Null for `os`: the bin renames what it takes. */
  dest: string | null;
  kind: "file" | "record";
  sessionId?: string;
  reason?: string;
}

/** Beside ~/.lax/trash, never inside it. That directory holds only date
 *  folders and `task/`, and both the sweeper and existing callers walk it
 *  assuming every entry is a directory — a stray file there is read with
 *  readdirSync and throws ENOTDIR. Caught by safe-delete.test.ts the first
 *  time this lived at trash/journal.jsonl. */
function journalPath(): string {
  return join(getLaxDir(), "trash-journal.jsonl");
}

/** Record one deletion. Never throws — a delete that succeeded must not be
 *  reported as failed because its receipt could not be written. */
export function appendTrashJournal(entry: Omit<TrashJournalEntry, "at"> & { at?: number }): void {
  try {
    const path = journalPath();
    mkdirSync(getLaxDir(), { recursive: true });
    const row: TrashJournalEntry = {
      at: entry.at ?? Date.now(),
      original: entry.kind === "file" ? resolve(entry.original) : entry.original,
      tier: entry.tier,
      dest: entry.dest,
      kind: entry.kind,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch (e) {
    logger.warn(`could not record the deletion of ${entry.original}: ${(e as Error).message}`);
  }
}

/** Every journalled deletion, oldest first. A corrupt line is skipped, not
 *  fatal: half a journal still restores half the files. */
export function readTrashJournal(): TrashJournalEntry[] {
  const path = journalPath();
  if (!existsSync(path)) return [];
  try {
    const out: TrashJournalEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as TrashJournalEntry;
        if (typeof row.original === "string" && typeof row.tier === "string") out.push(row);
      } catch { /* one bad line */ }
    }
    return out;
  } catch (e) {
    logger.warn(`trash journal unreadable: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The most recent deletion matching `ref`, which may be an absolute path, a
 * bare basename, or a record name. Most-recent-wins mirrors the task-trash
 * rule: the same name deleted twice restores the newer copy.
 */
export function findTrashEntry(ref: string, opts: { kind?: "file" | "record" } = {}): TrashJournalEntry | null {
  const wanted = resolve(ref);
  const base = basename(ref);
  const matches = readTrashJournal().filter((e) =>
    (opts.kind ? e.kind === opts.kind : true) &&
    (e.original === wanted || e.original === ref || basename(e.original) === base),
  );
  return matches.length ? matches[matches.length - 1] : null;
}

/** Deletions still worth offering a restore for, newest first. Entries whose
 *  bytes we can name and no longer find are dropped — offering a restore that
 *  cannot work is worse than saying nothing. */
export function listRestorable(opts: { kind?: "file" | "record"; limit?: number } = {}): TrashJournalEntry[] {
  const seen = new Set<string>();
  const out: TrashJournalEntry[] = [];
  for (const e of [...readTrashJournal()].reverse()) {
    if (opts.kind && e.kind !== opts.kind) continue;
    if (seen.has(e.original)) continue;      // only the newest delete per path
    seen.add(e.original);
    if (e.dest !== null && !existsSync(e.dest)) continue;  // swept
    if (e.kind === "file" && existsSync(e.original)) continue;  // already back
    out.push(e);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}
