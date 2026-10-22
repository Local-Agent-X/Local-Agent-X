// What a write or edit changed, so a device can show the diff: lines added and removed,
// and the hunks. The desktop attaches it to a tool call's result metadata
// (`metadata.fileChange`, LAX src/tools/file-change.ts), both on the live `tool_end` and
// on the tool events of a reloaded history.

import { asNumber, asRecord, asString } from "./guards.js";

export type FileChangeHunk = {
  oldStart: number;
  newStart: number;
  /** Diff lines, each prefixed "+", "-" or " ". */
  lines: string[];
};

export type FileChange = {
  path: string;
  /** The file did not exist before the write. */
  created: boolean;
  added: number;
  removed: number;
  /** Absent when the contents are not shown (a credential file, a diff too large). */
  hunks?: FileChangeHunk[];
  /** Lines were left out of a long diff. */
  truncated?: true;
};

function parseHunk(raw: unknown): FileChangeHunk | null {
  const r = asRecord(raw);
  const oldStart = asNumber(r?.oldStart);
  const newStart = asNumber(r?.newStart);
  if (r === null || oldStart === null || newStart === null || !Array.isArray(r.lines)) return null;
  return { oldStart, newStart, lines: r.lines.filter((l): l is string => typeof l === "string") };
}

/** The file change in a tool result's metadata, or null when it carries none. */
export function parseFileChange(metadata: unknown): FileChange | null {
  const r = asRecord(asRecord(metadata)?.fileChange);
  const path = asString(r?.path);
  if (r === null || path === null) return null;
  const change: FileChange = { path, created: r.created === true, added: asNumber(r.added) ?? 0, removed: asNumber(r.removed) ?? 0 };
  if (Array.isArray(r.hunks)) change.hunks = r.hunks.map(parseHunk).filter((h): h is FileChangeHunk => h !== null);
  if (r.truncated === true) change.truncated = true;
  return change;
}
