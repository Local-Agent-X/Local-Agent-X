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
export function figureFileKey(path: string): string {
  let real: string;
  try { real = realpathDeep(resolve(path)); } catch { real = resolve(path); }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** A file's figures check, if one ran this process: "checking" or
 *  "correcting" while it runs, then its result. */
export function figureCheckOf(path: string): FigureCheckStatus | null {
  return fileStates.get(figureFileKey(path)) ?? null;
}

/** Who waits for a session's check to finish (checkBeforeDone). `rescale`
 *  stretches the wait to a check that runs in several rounds of passes. */
interface Waiter { onFinal: () => void; rescale: (rounds: number) => void }
const waiters = new Map<string, Waiter[]>();
const FINAL: ReadonlySet<FigureCheckStatus> = new Set(["confirmed", "corrected", "mismatch", "unchecked"]);
/** The longest any wait stretches to, however many rounds a check has. */
const MAX_WAIT_MS = 15 * 60_000;

/** Resolves true when the session's current check reaches a final state,
 *  false after `timeoutMs` (per round of passes) or when `signal` aborts.
 *  Register before starting. */
export function awaitFigureCheck(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const started = Date.now();
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const list = waiters.get(sessionId);
      if (list) waiters.set(sessionId, list.filter((w) => w !== waiter));
      done(v);
    };
    const arm = (ms: number) => { const t = setTimeout(() => finish(false), Math.max(0, ms)); t.unref?.(); return t; };
    const onAbort = () => finish(false);
    let timer = arm(timeoutMs);
    const waiter: Waiter = {
      onFinal: () => finish(true),
      rescale: (rounds) => {
        if (settled) return;
        clearTimeout(timer);
        timer = arm(Math.min(MAX_WAIT_MS, timeoutMs * Math.max(1, rounds)) - (Date.now() - started));
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), waiter]);
    if (signal?.aborted) finish(false);
  });
}

/** A listed check (figure-check-run.ts) runs its passes in `rounds` rounds:
 *  whoever waits for it waits that many times as long, up to MAX_WAIT_MS. */
export function expectFigureCheckRounds(sessionId: string, rounds: number): void {
  for (const w of waiters.get(sessionId) ?? []) w.rescale(rounds);
}

const sessionsDir = () => join(getLaxDir(), "sessions");

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const capitalized = (s: string) => s[0].toUpperCase() + s.slice(1);

/** How much of the files' figures a check covered: `checked` looked at so far,
 *  of `total` listed (null when a file's figures could not be listed). */
export interface FigureCoverage { checked: number; total: number | null }

/** "Checked 16 of 40 figures", "Checked all 40 figures", "Checked 6 figures". */
function checkedPhrase(c: FigureCoverage): string {
  if (c.total === null) return `Checked ${plural(c.checked, "figure")}`;
  return c.checked >= c.total ? `Checked all ${plural(c.total, "figure")}` : `Checked ${c.checked} of ${plural(c.total, "figure")}`;
}

/** After a correction or mismatch, what is still unchecked. */
function restTail(c: FigureCoverage | undefined): string {
  return c && c.total !== null && c.checked < c.total ? ` ${c.checked} of ${plural(c.total, "figure")} checked so far; ask me to check the rest.` : "";
}

function textFor(status: FigureCheckStatus, mismatched: number, files: string[], beforeDone: boolean, coverage?: FigureCoverage): string {
  const where = files.length ? ` in ${files.map((f) => basename(f)).join(", ")}` : "";
  const some = mismatched > 0 ? plural(mismatched, "figure") : "some figures";
  switch (status) {
    case "checking": return `Checking the figures${where} against their sources…`;
    case "correcting": return `${capitalized(some)}${where} didn't match their sources. Correcting them…`;
    case "corrected": return `Corrected ${some}${where}${beforeDone ? "" : " after this answer"} to match their sources.${restTail(coverage)}`;
    case "mismatch": return `${capitalized(some)}${where} ${mismatched === 1 ? "doesn't" : "don't"} match their sources and couldn't be corrected automatically. Ask me to go through them.${restTail(coverage)}`;
    case "confirmed": {
      if (!coverage || coverage.checked === 0) return `Checked the figures${where} against their sources: they match.`;
      const rest = coverage.total !== null && coverage.checked < coverage.total ? " Ask me to check the rest." : "";
      return `${checkedPhrase(coverage)}${where} against their sources: they match.${rest}`;
    }
    case "unchecked": return `Couldn't check the figures${where} against their sources.`;
  }
}

/** The session's latest note text: what a check the user asked for reports back. */
const lastText = new Map<string, string>();

export function lastFigureCheckText(sessionId: string): string | null {
  return lastText.get(sessionId) ?? null;
}

function write(sessionId: string, note: ReplyNote): void {
  lastText.set(sessionId, note.text);
  for (const f of note.files ?? []) fileStates.set(figureFileKey(f), note.status);
  try {
    upsertReplyNote(sessionsDir(), sessionId, note);
  } catch (e) {
    logger.warn(`could not save the figures note for ${sessionId}: ${(e as Error).message}`);
  }
  try { broadcaster?.(sessionId, { type: "reply_note", note }); } catch { /* the saved note shows on the next load */ }
  if (FINAL.has(note.status)) {
    const list = waiters.get(sessionId) ?? [];
    waiters.delete(sessionId);
    for (const w of list) w.onFinal();
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
export function figureCheckUpdate(sessionId: string, status: FigureCheckStatus, mismatched = 0, coverage?: FigureCoverage): void {
  const now = Date.now();
  const entry = current.get(sessionId) ?? { id: `figures-${now}`, at: now, files: [] };
  if (status !== "correcting" && status !== "checking") current.delete(sessionId);
  else current.set(sessionId, entry);
  const cov = coverage ?? coverages.get(sessionId);
  if (coverage && (status === "correcting" || status === "checking")) coverages.set(sessionId, coverage);
  else coverages.delete(sessionId);
  write(sessionId, { ...entry, kind: "figures", status, text: textFor(status, mismatched, entry.files ?? [], entry.on === "next", cov), updatedAt: now });
}

/** A correcting check's coverage, held until its correction lands. */
const coverages = new Map<string, FigureCoverage>();

/** Test-only: forget the checks under way. */
export function _resetFigureCheckNotesForTests(): void {
  current.clear();
  coverages.clear();
  lastText.clear();
  fileStates.clear();
  waiters.clear();
  broadcaster = null;
}
