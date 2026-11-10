/**
 * Hand-over notes between agents working in one repo (ADR 0007 §3): a short
 * feed of "changed X, here's why", read by the others at the start of a turn
 * (other-agents-block.ts) and at the moment one is about to write a file
 * another is changing (claim-clash-gate.ts).
 *
 * Written by an agent (`work_note`), by a merge (`merged`, worktree-lifecycle.ts)
 * and by a worker that finished (`finished`). A note is another agent's words:
 * whoever shows it to a model frames it as data, never as instructions.
 *
 * One fsynced JSONL file per repo per day under
 * `<lax dir>/coordination/notes/<repo>/`, appended under a lock
 * (persistence/durable-jsonl.ts); days older than KEEP_DAYS are deleted on read.
 */
import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { ensureDurableDirectory } from "../persistence/durable-directory.js";
import { readDurableJsonl, updateDurableJsonl } from "../persistence/durable-jsonl.js";
import { randomId } from "../util/ids.js";

export const NOTE_TEXT_MAX = 600;
const KEEP_DAYS = 14;

export interface HandoverNote {
  id: string;
  at: string;
  sessionId: string;
  displayName: string;
  repoKey: string;
  /** Repo-relative paths the note is about. */
  paths: string[];
  text: string;
  kind: "agent" | "merged" | "finished";
}

let dirOverride: string | null = null;
let now: () => number = Date.now;

function repoDir(repoKey: string): string {
  const id = createHash("sha256").update(repoKey).digest("hex").slice(0, 24);
  return join(dirOverride ?? join(getLaxDir(), "coordination", "notes"), id);
}

function isNote(v: unknown): v is HandoverNote {
  const n = v as HandoverNote;
  return !!n && typeof n.id === "string" && typeof n.at === "string" && typeof n.text === "string"
    && typeof n.repoKey === "string" && Array.isArray(n.paths);
}

/** Post a note; returns it as stored. */
export function postNote(input: Omit<HandoverNote, "id" | "at">): HandoverNote {
  const note: HandoverNote = {
    ...input,
    id: randomId("note"),
    at: new Date(now()).toISOString(),
    text: input.text.replace(/\s+/g, " ").trim().slice(0, NOTE_TEXT_MAX),
    paths: input.paths.slice(0, 50),
  };
  const dir = repoDir(input.repoKey);
  ensureDurableDirectory(dir);
  updateDurableJsonl(join(dir, `${note.at.slice(0, 10)}.jsonl`), isNote, () => note);
  return note;
}

/** Notes in `repoKey` newer than `sinceIso`, oldest first. */
export function notesSince(repoKey: string, sinceIso?: string): HandoverNote[] {
  const dir = repoDir(repoKey);
  let days: string[] = [];
  try { days = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch { return []; }
  const oldest = new Date(now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const since = sinceIso ?? "";
  const out: HandoverNote[] = [];
  for (const day of days) {
    if (day.slice(0, 10) < oldest) { try { rmSync(join(dir, day), { force: true }); } catch { /* swept by another reader */ } continue; }
    if (since && day.slice(0, 10) < since.slice(0, 10)) continue;
    for (const n of readDurableJsonl(join(dir, day), isNote)) if (n.at > since) out.push(n);
  }
  return out;
}

/** The latest note `sessionId` posted in `repoKey`, if any. */
export function latestNoteBy(repoKey: string, sessionId: string): HandoverNote | null {
  const mine = notesSince(repoKey).filter((n) => n.sessionId === sessionId);
  return mine.length ? mine[mine.length - 1] : null;
}

/** Test seams. */
export function _setHandoverNotesForTest(opts: { dir?: string | null; clock?: () => number }): void {
  if (opts.dir !== undefined) dirOverride = opts.dir;
  if (opts.clock) now = opts.clock;
}
export function _resetHandoverNotesForTest(): void {
  dirOverride = null; now = Date.now;
}
