/**
 * What a file-writing tool changed, as the chat shows it: lines added and
 * removed, and the diff hunks. It rides the result's `metadata.fileChange`, an
 * object, so the model's header skips it (renderToolResultForModel) while the
 * tool message's carry keeps it for the live card and the reloaded one: the
 * chat's "Edited N files" card and its diff view read it, and nothing else does.
 */
import { structuredPatch } from "diff";
import { isSensitivePath } from "../data-lineage/index.js";

export interface FileChangeHunk {
  oldStart: number;
  newStart: number;
  /** Diff lines, each prefixed "+", "-" or " ". */
  lines: string[];
}

export interface FileChange {
  path: string;
  /** The file did not exist before this write. */
  created: boolean;
  added: number;
  removed: number;
  /** Absent for a credential file, whose contents are never shown, and for a
   *  diff too large to work out in time. */
  hunks?: FileChangeHunk[];
  /** Lines were left out past MAX_DIFF_LINES. */
  truncated?: true;
}

/** Enough to read a real edit; a rewrite of a big file shows its start. */
const MAX_DIFF_LINES = 400;
/** A diff of two large, very different files can take seconds; past this the
 *  card shows counts only. */
const DIFF_TIMEOUT_MS = 250;

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function fileChangeOf(path: string, before: string | null, after: string): FileChange {
  const created = before === null;
  // Line endings are kept by every writer, so they are never the change.
  const oldText = (before ?? "").replace(/\r\n/g, "\n");
  const newText = after.replace(/\r\n/g, "\n");
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3, timeout: DIFF_TIMEOUT_MS });
  if (!patch) return { path, created, added: lineCount(newText), removed: lineCount(oldText) };

  let added = 0;
  let removed = 0;
  for (const h of patch.hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  const change: FileChange = { path, created, added, removed };
  if (isSensitivePath(path)) return change;

  const hunks: FileChangeHunk[] = [];
  let budget = MAX_DIFF_LINES;
  for (const h of patch.hunks) {
    if (budget <= 0) {
      change.truncated = true;
      break;
    }
    // "\ No newline at end of file" markers say nothing a reader needs.
    const lines = h.lines.filter((l) => !l.startsWith("\\"));
    if (lines.length > budget) change.truncated = true;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: lines.slice(0, budget) });
    budget -= lines.length;
  }
  change.hunks = hunks;
  return change;
}
