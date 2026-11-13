import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The memory notes (memory/*.md) this machine last saw in the sync repo.
//
// A note missing from the sync repo is either one another machine deleted or
// one this machine wrote and has not pushed yet. Only the first may be deleted
// here, and only this record tells them apart: a note the repo held at the
// last push or pull and no longer holds was removed elsewhere; a note it never
// held is new here and waits for the next push. Without the record, every
// startup pull deleted the day's notes that had not been pushed (2026-11-13:
// the day's file deleted at each restart while pushes were not running).
//
// Same idea as the app snapshot in tombstones.ts, kept per machine.

function recordFile(dataDir: string): string {
  return join(dataDir, "sync-state", "synced-memory-notes.json");
}

/** The notes the sync repo held at this machine's last push or pull; null when none was ever recorded. */
export function readSyncedNotes(dataDir: string): Set<string> | null {
  const file = recordFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    const names = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(names) ? new Set(names.filter((n): n is string => typeof n === "string")) : null;
  } catch {
    // An unreadable record is treated as none: nothing is deleted on its say-so.
    return null;
  }
}

export function recordSyncedNotes(dataDir: string, names: Iterable<string>): void {
  const file = recordFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...names].sort(), null, 2), "utf-8");
}
