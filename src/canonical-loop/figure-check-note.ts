/**
 * What the user sees of the figures check: one note on the reply whose
 * deliverables it checks, updated in place as the check runs, and saved
 * beside the chat (memory/reply-notes.ts) so it is still there after a reload.
 *
 *   checking    the check started (the chat went quiet after the reply)
 *   correcting  figures did not match; a correction is under way
 *   corrected   the correction landed
 *   mismatch    figures do not match and could not be corrected automatically
 *   confirmed   the figures match their sources
 *   unchecked   the check could not run or could not settle the figures
 *
 * Before this, the result was a separate chat line posted minutes after the
 * "final" answer, held only by the open tab (idle-nudge.ts), so it read as an
 * afterthought and vanished on reload (2026-11-24). The agent's own record is
 * unchanged: the pending notification still tells it what was found.
 */
import { basename, join, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { realpathDeep } from "../workspace/paths.js";
import { upsertReplyNote, type FigureCheckStatus, type ReplyNote } from "../memory/reply-notes.js";
import type { ServerEvent } from "../types/server-events.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.figure-check-note");

let broadcaster: ((sessionId: string, event: ServerEvent) => void) | null = null;

/** Wired by the chat socket (chat-ws/bridge-wiring.ts): the note's live update. */
export function setFigureCheckBroadcaster(fn: ((sessionId: string, event: ServerEvent) => void) | null): void {
  broadcaster = fn;
}

/** The check under way per session: the note it updates. */
const current = new Map<string, Pick<ReplyNote, "id" | "at" | "files" | "on">>();

/** Each checked file's last state, by normalized path: what the send guard
 *  reads (tool-execution/figure-check-send-gate.ts). In memory only, so a
 *  restart forgets it and a send after one is not held. */
const fileStates = new Map<string, FigureCheckStatus>();
/** One key per file however its path is written: links resolved, as the
 *  artifact registry records deliverables (data-lineage/task-artifacts.ts), so
 *  a deck reached through a junctioned workspace is the same deck. */
function fileKey(path: string): string {
  let real: string;
  try { real = realpathDeep(resolve(path)); } catch { real = resolve(path); }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** A file's figures check, if one ran this process: "checking" or
 *  "correcting" while it runs, then its result. */
export function figureCheckOf(path: string): FigureCheckStatus | null {
  return fileStates.get(fileKey(path)) ?? null;
}

/** Who waits for a session's check to finish (checkBeforeDone). */
const waiters = new Map<string, Array<() => void>>();
const FINAL: ReadonlySet<FigureCheckStatus> = new Set(["confirmed", "corrected", "mismatch", "unchecked"]);

/** Resolves true when the session's current check reaches a final state,
 *  false after `timeoutMs` or when `signal` aborts. Register before starting. */
export function awaitFigureCheck(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const list = waiters.get(sessionId);
      if (list) waiters.set(sessionId, list.filter((w) => w !== onFinal));
      done(v);
    };
    const onFinal = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), onFinal]);
    if (signal?.aborted) finish(false);
  });
}

const sessionsDir = () => join(getLaxDir(), "sessions");

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const capitalized = (s: string) => s[0].toUpperCase() + s.slice(1);

function textFor(status: FigureCheckStatus, mismatched: number, files: string[], beforeDone: boolean): string {
  const where = files.length ? ` in ${files.map((f) => basename(f)).join(", ")}` : "";
  const some = mismatched > 0 ? plural(mismatched, "figure") : "some figures";
  switch (status) {
    case "checking": return `Checking the figures${where} against their sources…`;
    case "correcting": return `${capitalized(some)}${where} didn't match their sources. Correcting them…`;
    case "corrected": return `Corrected ${some}${where}${beforeDone ? "" : " after this answer"} to match their sources.`;
    case "mismatch": return `${capitalized(some)}${where} ${mismatched === 1 ? "doesn't" : "don't"} match their sources and couldn't be corrected automatically. Ask me to go through them.`;
    case "confirmed": return `Checked the figures${where} against their sources: they match.`;
    case "unchecked": return `Couldn't check the figures${where} against their sources.`;
  }
}

function write(sessionId: string, note: ReplyNote): void {
  for (const f of note.files ?? []) fileStates.set(fileKey(f), note.status);
  try {
    upsertReplyNote(sessionsDir(), sessionId, note);
  } catch (e) {
    logger.warn(`could not save the figures note for ${sessionId}: ${(e as Error).message}`);
  }
  try { broadcaster?.(sessionId, { type: "reply_note", note }); } catch { /* the saved note shows on the next load */ }
  if (FINAL.has(note.status)) {
    const list = waiters.get(sessionId) ?? [];
    waiters.delete(sessionId);
    for (const w of list) w();
  }
}

/** The check was submitted: the reply gets its "checking" note. `beforeDone`:
 *  the turn under check has not said it is done yet, so the note belongs to
 *  the reply that ends it (ReplyNote.on). */
export function figureCheckStarted(sessionId: string, files: string[], beforeDone = false): void {
  const at = Date.now();
  const entry = { id: `figures-${at}`, at, files, ...(beforeDone ? { on: "next" as const } : {}) };
  current.set(sessionId, entry);
  write(sessionId, { ...entry, kind: "figures", status: "checking", text: textFor("checking", 0, files, beforeDone), updatedAt: at });
}

/** A later state of the session's check. With no check on record (a restart
 *  in between), the note is made fresh, on the reply before now. */
export function figureCheckUpdate(sessionId: string, status: FigureCheckStatus, mismatched = 0): void {
  const now = Date.now();
  const entry = current.get(sessionId) ?? { id: `figures-${now}`, at: now, files: [] };
  if (status !== "correcting" && status !== "checking") current.delete(sessionId);
  else current.set(sessionId, entry);
  write(sessionId, { ...entry, kind: "figures", status, text: textFor(status, mismatched, entry.files ?? [], entry.on === "next"), updatedAt: now });
}

/** Test-only: forget the checks under way. */
export function _resetFigureCheckNotesForTests(): void {
  current.clear();
  fileStates.clear();
  waiters.clear();
  broadcaster = null;
}
