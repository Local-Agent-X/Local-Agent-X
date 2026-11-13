/**
 * How far each dream has read each session, so the next dream reads only what
 * was said since.
 *
 * Dream used to take the ten most recently changed sessions and send each one
 * whole, every run. A conversation that had not changed in a day was mined
 * again by every dream in between, and the only guard against saving the same
 * thing twice was that the model noticed it was already stored. Word-overlap
 * de-duplication cannot see a paraphrase, so a re-read conversation came back
 * as a second fact in other words (2026-11-13: a retatrutide question from a
 * phone chat that last changed on 11-12 03:21 UTC was sent to four dreams and
 * saved twice, "a 30-unit pull was" and "a 30-unit pull would be").
 *
 * A mark records, per session, how many messages a finished dream had read and
 * a hash of the last of them. The next dream sends the messages after it, with
 * the few before it as context the prompt says to save nothing from. A session
 * whose earlier messages changed (an edit rewound it) is read whole again.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractSessionPairs, type ConversationMessage } from "./chunking.js";
import { readSessionLogRows, sessionLogMeta } from "./session-log-rows.js";
import { isSyntheticSessionId } from "./synthetic-sessions.js";

export interface SessionReviewMark {
  /** The session file's mtime when it was read. */
  mtime: number;
  /** Messages read, counted from the start of the session. */
  messages: number;
  /** Hash of the last message read, to tell a session that grew from one rewritten. */
  lastHash: string;
}

export interface ReviewMarks {
  /** Sessions with no mark that last changed at or before this time count as
   *  read: they were in the dreams before marks existed. */
  from: number;
  sessions: Record<string, SessionReviewMark>;
}

export interface SessionTranscript {
  sessionId: string;
  date: string | undefined;
  title: string | undefined;
  /** Messages no dream has read yet. */
  pairs: ConversationMessage[];
  /** The messages just before `pairs`, already read: context only. */
  earlier: ConversationMessage[];
  approxTokens: number;
  /** The mark to record once a dream has finished reading this. */
  mark: SessionReviewMark;
}

/** Already-read messages shown before the new ones, so a short follow-up still
 *  makes sense ("yes, do that"). */
export const EARLIER_CONTEXT_MESSAGES = 4;
/** Marks kept, newest first; an older session that changes is read whole once. */
const MAX_MARKS = 500;

export function messageHash(message: ConversationMessage): string {
  return createHash("sha256").update(`${message.role}\n${message.content}`).digest("hex").slice(0, 16);
}

/** The read and unread parts of a session, given its mark. */
export function splitUnreviewed(
  mark: SessionReviewMark | undefined,
  messages: ConversationMessage[],
): { earlier: ConversationMessage[]; fresh: ConversationMessage[] } {
  const seen = mark?.messages ?? 0;
  if (seen <= 0 || seen > messages.length || messageHash(messages[seen - 1]) !== mark!.lastHash) {
    return { earlier: [], fresh: messages };
  }
  return { earlier: messages.slice(Math.max(0, seen - EARLIER_CONTEXT_MESSAGES), seen), fresh: messages.slice(seen) };
}

function markFor(mtime: number, messages: ConversationMessage[]): SessionReviewMark {
  const last = messages[messages.length - 1];
  return { mtime, messages: messages.length, lastHash: last ? messageHash(last) : "" };
}

/** Changed since it was last read, judged from the file time alone. */
function mayHaveNew(marks: ReviewMarks, sessionId: string, mtime: number): boolean {
  const mark = marks.sessions[sessionId];
  return mtime > (mark ? mark.mtime : marks.from);
}

/** Sessions changed since a dream last read them, most recently changed first.
 *  Judged from file times; a changed session may still have nothing new. */
function changedSessions(dir: string, marks: ReviewMarks): Array<{ file: string; mtime: number }> {
  return readdirSync(dir)
    // Exclude generated/internal sessions — above all dream-*.jsonl. Without
    // this, each dream re-ingested prior dreams' embedded transcripts and the
    // file grew exponentially (one hit 150 MB). See synthetic-sessions.ts.
    .filter((f) => f.endsWith(".jsonl") && !isSyntheticSessionId(f))
    .map((f) => {
      try { return { file: f, mtime: statSync(join(dir, f)).mtimeMs }; } catch { return null; }
    })
    .filter((x): x is { file: string; mtime: number } => x !== null)
    .filter(({ file, mtime }) => mayHaveNew(marks, file.replace(/\.jsonl$/, ""), mtime))
    .sort((a, b) => b.mtime - a.mtime);
}

/** How many sessions a dream has not read since they last changed. A session
 *  that waits behind the per-dream limit stays counted, so a backlog left by
 *  dreams that did not run keeps the next one due. */
export function countUnreviewedSessions(dir: string, marks: ReviewMarks): number {
  return changedSessions(dir, marks).length;
}

/**
 * Up to `limit` sessions with messages no dream has read, most recently
 * changed first, each carrying only those messages and a little context. The
 * rest wait for the next dream: nothing is dropped for being past the limit.
 */
export function readUnreviewedSessions(dir: string, marks: ReviewMarks, limit: number): SessionTranscript[] {
  const out: SessionTranscript[] = [];
  for (const { file, mtime } of changedSessions(dir, marks)) {
    if (out.length >= limit) break;
    const fullPath = join(dir, file);
    const sessionId = file.replace(/\.jsonl$/, "");
    const messages = extractSessionPairs(fullPath);
    if (messages.length < 2) continue;
    const { earlier, fresh } = splitUnreviewed(marks.sessions[sessionId], messages);
    if (fresh.length === 0) continue;
    const meta = sessionLogMeta(readSessionLogRows(fullPath) ?? []);
    const date = meta && typeof meta.createdAt === "number" ? new Date(meta.createdAt).toISOString().split("T")[0] : undefined;
    const title = typeof meta?.title === "string" ? meta.title : undefined;
    const charCount = [...earlier, ...fresh].reduce((sum, m) => sum + m.content.length, 0);
    out.push({
      sessionId, date, title, pairs: fresh, earlier,
      approxTokens: Math.ceil(charCount / 4), mark: markFor(mtime, messages),
    });
  }
  return out;
}

/** `marks` with what a finished dream read added, keeping the newest MAX_MARKS. */
export function withReviewed(marks: ReviewMarks, read: SessionTranscript[]): ReviewMarks {
  const sessions = { ...marks.sessions };
  for (const t of read) sessions[t.sessionId] = t.mark;
  const kept = Object.entries(sessions).sort((a, b) => b[1].mtime - a[1].mtime).slice(0, MAX_MARKS);
  return { from: marks.from, sessions: Object.fromEntries(kept) };
}
