/**
 * Notes that land on a reply after it ended: today, the result of the figures
 * check (canonical-loop/figure-check-note.ts), which re-checks a deliverable's
 * numbers against their sources once the chat goes quiet.
 *
 * They are the user's record, never the model's: the transcript (`<id>.jsonl`)
 * is what the model reads back, so they live beside it as `<id>.notes.json`
 * and are joined onto the reply only when a chat is loaded for the screen
 * (session-ui-projection.ts). Before this file existed the result reached the
 * open tab alone and vanished on reload, so a corrected report left no trace
 * that it had been corrected after the user read it (2026-11-24).
 *
 * A note says which reply it belongs to by time: `at` is when it was made,
 * and it attaches to the last reply at or before that moment.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./utils.js";

export type FigureCheckStatus = "checking" | "correcting" | "confirmed" | "corrected" | "mismatch" | "unchecked";

export interface ReplyNote {
  /** One per check; a later status for the same check replaces it. */
  id: string;
  kind: "figures";
  /** Epoch ms the check began: the note belongs to the last reply before it. */
  at: number;
  status: FigureCheckStatus;
  text: string;
  /** The deliverables the check covered. */
  files?: string[];
  updatedAt: number;
}

/** A chat keeps its most recent notes; older ones are dropped first. */
const MAX_NOTES = 50;
const STATUSES = new Set<FigureCheckStatus>(["checking", "correcting", "confirmed", "corrected", "mismatch", "unchecked"]);

const notesPath = (dir: string, id: string) => join(dir, `${id}.notes.json`);

function isNote(v: unknown): v is ReplyNote {
  const n = v as ReplyNote;
  return !!n && typeof n.id === "string" && n.kind === "figures" && typeof n.at === "number"
    && STATUSES.has(n.status) && typeof n.text === "string";
}

export function readReplyNotes(dir: string, id: string): ReplyNote[] {
  const path = notesPath(dir, id);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter(isNote) : [];
  } catch {
    return []; // unreadable: the chat still loads, without its notes
  }
}

/** Add a note, or replace the one with the same id. */
export function upsertReplyNote(dir: string, id: string, note: ReplyNote): void {
  const notes = readReplyNotes(dir, id).filter((n) => n.id !== note.id);
  notes.push(note);
  atomicWriteFileSync(notesPath(dir, id), JSON.stringify(notes.slice(-MAX_NOTES)));
}

export function deleteReplyNotes(dir: string, id: string): void {
  const path = notesPath(dir, id);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best-effort, like the transcript's own delete */ }
  }
}

type UIMessage = { role: string; _at?: number; _notices?: unknown[] };

/**
 * Join each note onto its reply: the last assistant message at or before the
 * note's `at`, or the last assistant message when none says when it was
 * written. A note with no reply to join is dropped.
 */
export function attachReplyNotes<T extends UIMessage>(messages: T[], notes: readonly ReplyNote[]): T[] {
  if (notes.length === 0) return messages;
  const out = messages.slice();
  for (const note of notes) {
    let target = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i];
      if (m.role !== "assistant") continue;
      if (target < 0) target = i; // fallback: the last reply
      if (typeof m._at === "number" && m._at <= note.at) { target = i; break; }
    }
    if (target < 0) continue;
    const m = out[target];
    out[target] = { ...m, _notices: [...(m._notices ?? []).filter((n) => (n as { id?: string }).id !== note.id), note] };
  }
  return out;
}
