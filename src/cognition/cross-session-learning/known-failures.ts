/**
 * What has been decided about each recurring failure (failure-patterns.ts):
 * the review's verdict, and for a failure with a lesson, whether the user kept
 * it and whether it has helped since.
 *
 * A lesson is one or two sentences: what fails here and what worked instead.
 * It reaches the agent in exactly one place, as a note on the result of a call
 * that just failed the same way (tool-execution/known-failure-note.ts), and
 * only in state `kept`. Nothing here is ever in the prompt of a turn that did
 * not hit the failure.
 *
 * Two rules protect the user from a bad lesson:
 *  - A model wrote it from past tool output, so it is `proposed` until the
 *    user keeps it (the owner's call, 2026-11-11), and its text passes the
 *    memory write gate (taint check, sanitize, secret redaction) before it is
 *    stored at all.
 *  - A kept lesson that does not help retires itself: shown at least
 *    RETIRE_MIN_SHOWN times with the same work succeeding afterwards less
 *    than RETIRE_MIN_RECOVERY of the time. Retired is not discarded: the user
 *    can keep it again, which starts the count over.
 *
 * Stays on this computer (not synced): paths and installed programs differ
 * from one machine to the next, like learned procedures.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { createJsonStore } from "../../util/json-store.js";
import { runMemoryGate } from "../../memory/write-safely.js";
import { createInternalMemoryContext } from "../../memory/promotion-gate.js";
import { withLearnedLifecycleTransaction } from "../../protocols/learned-lifecycle-transaction.js";
import type { FailurePattern } from "./failure-patterns.js";

export const MAX_LESSON_CHARS = 300;
export const RETIRE_MIN_SHOWN = 5;
export const RETIRE_MIN_RECOVERY = 0.4;
/** A failure judged noise or an app gap is looked at again once it has spread
 *  to this many times the chats it had when it was judged. */
const REREVIEW_GROWTH = 2;
const MAX_KNOWN = 500;

export type FailureVerdict = "lesson" | "app_gap" | "noise";
export type LessonState = "proposed" | "kept" | "discarded" | "retired";

export interface KnownFailure {
  signature: string;
  tool: string;
  action?: string;
  status: string;
  reason: string;
  verdict: FailureVerdict;
  /** The review's one-line reason for the verdict. */
  why: string;
  /** Present only for verdict "lesson". */
  lesson?: string;
  state?: LessonState;
  /** How widespread the failure was when it was reviewed. */
  sessions: number;
  count: number;
  reviewedAt: number;
  /** Times the kept lesson was put on a failed result, and times the same
   *  work then succeeded in that run. */
  shown: number;
  recovered: number;
}

interface KnownFailureStore extends Record<string, unknown> {
  failures: KnownFailure[];
  lastReviewAt: number;
}

export function knownFailuresPath(): string {
  return join(getLaxDir(), "known-failures.json");
}

function store() {
  return createJsonStore<KnownFailureStore>(knownFailuresPath(), {
    defaults: () => ({ failures: [], lastReviewAt: 0 }),
    caps: { failures: MAX_KNOWN },
  });
}

/** Kept lessons as last read, for the lookup under "Delivery" below. */
let cache: { mtimeMs: number; kept: Map<string, KnownFailure> } | null = null;

/**
 * Every change to the file, as one read-modify-write under the learning
 * stores' cross-process lock (protocols/learned-lifecycle-transaction.ts).
 * More than one process writes here: the server (the review, the user's Keep
 * or Discard) and any worker child whose failed call is shown a lesson.
 * Without the lock a worker counting a showing could write back the state it
 * read a moment before the user discarded the lesson, and bring it back.
 */
function mutate<R>(change: (draft: KnownFailureStore) => R): R {
  try {
    return withLearnedLifecycleTransaction(() => store().mutate(change));
  } finally {
    // This process just changed the file; the next lookup re-reads it. The
    // mtime check alone is not enough: two writes can land in one timestamp.
    cache = null;
  }
}

export function listKnownFailures(): KnownFailure[] {
  return store().load().failures;
}

export function lastFailureReviewAt(): number {
  return store().load().lastReviewAt;
}

export function noteFailureReviewRan(now: number): void {
  mutate((draft) => { draft.lastReviewAt = now; });
}

/**
 * Whether a recurring failure is due a review. Never one the user has decided
 * about, one waiting on them, or one that retired: a second opinion from the
 * same reviewer would only ask them again.
 */
export function needsReview(pattern: FailurePattern, known: KnownFailure | undefined): boolean {
  if (!known) return true;
  if (known.verdict === "lesson") return false;
  return pattern.sessions >= known.sessions * REREVIEW_GROWTH;
}

export interface ReviewVerdict {
  verdict: FailureVerdict;
  why: string;
  lesson?: string;
}

/**
 * Put a review's verdict on record. A lesson is stored as `proposed`, its text
 * through the memory write gate; text the gate refuses makes the verdict
 * noise, with the refusal as the reason. Returns what was stored.
 */
export function recordFailureReview(pattern: FailurePattern, review: ReviewVerdict, now: number): KnownFailure {
  let verdict = review.verdict;
  let why = review.why.trim().slice(0, MAX_LESSON_CHARS);
  let lesson: string | undefined;
  if (verdict === "lesson") {
    try {
      const text = (review.lesson ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LESSON_CHARS);
      const target = knownFailuresPath();
      lesson = runMemoryGate({
        content: text, source: "tool", target,
        promotion: createInternalMemoryContext(text, target, "known-failures"),
      }).trim();
      if (!lesson) throw new Error("the lesson was empty");
    } catch (e) {
      // Not an app gap: nothing was learned about the tool, only that this
      // text may not be stored. Noise is looked at again if the failure spreads.
      verdict = "noise";
      why = `The lesson was not stored: ${(e as Error).message}`.slice(0, MAX_LESSON_CHARS);
      lesson = undefined;
    }
  }
  const record: KnownFailure = {
    signature: pattern.signature, tool: pattern.tool, status: pattern.status, reason: pattern.reason,
    ...(pattern.action ? { action: pattern.action } : {}),
    verdict, why,
    ...(lesson ? { lesson, state: "proposed" as const } : {}),
    sessions: pattern.sessions, count: pattern.count, reviewedAt: now, shown: 0, recovered: 0,
  };
  mutate((draft) => {
    draft.failures = [...draft.failures.filter((f) => f.signature !== record.signature), record];
  });
  return record;
}

export type LessonDecision = "keep" | "discard";

/** The user's answer to a lesson. Keeping one again starts its count over.
 *  Null when there is no lesson under that signature. */
export function decideLesson(signature: string, decision: LessonDecision): KnownFailure | null {
  return mutate((draft) => {
    const known = draft.failures.find((f) => f.signature === signature);
    if (!known || known.verdict !== "lesson") return null;
    if (decision === "keep" && known.state !== "kept") { known.shown = 0; known.recovered = 0; }
    known.state = decision === "keep" ? "kept" : "discarded";
    return { ...known };
  });
}

// ── Delivery ──
//
// The lookup runs on every failed tool call, so kept lessons are held in
// memory and re-read when the file changes: at once after a write by this
// process (mutate drops the copy), by its mtime after a write by another. A
// worker child process loads its own copy the first time one of its calls fails.

function keptLessons(): Map<string, KnownFailure> {
  let mtimeMs = 0;
  try { mtimeMs = statSync(knownFailuresPath()).mtimeMs; } catch { /* no file: no lessons */ }
  if (!cache || cache.mtimeMs !== mtimeMs) {
    const kept = new Map<string, KnownFailure>();
    if (mtimeMs) for (const f of listKnownFailures()) if (f.state === "kept" && f.lesson) kept.set(f.signature, f);
    cache = { mtimeMs, kept };
  }
  return cache.kept;
}

function hasStoppedHelping(known: KnownFailure): boolean {
  return known.shown >= RETIRE_MIN_SHOWN && known.recovered / known.shown < RETIRE_MIN_RECOVERY;
}

/**
 * The kept lesson for a failure that just happened, counted as shown. A
 * lesson that has stopped helping is retired here instead of delivered.
 */
export function takeLessonFor(signature: string): KnownFailure | undefined {
  if (!keptLessons().has(signature)) return undefined;
  return mutate((draft) => {
    const known = draft.failures.find((f) => f.signature === signature);
    if (!known || known.state !== "kept" || !known.lesson) return undefined;
    if (hasStoppedHelping(known)) { known.state = "retired"; return undefined; }
    known.shown += 1;
    return { ...known };
  });
}

/** The same work succeeded in a run that was shown this lesson. */
export function noteLessonHelped(signature: string): void {
  mutate((draft) => {
    const known = draft.failures.find((f) => f.signature === signature);
    if (known && known.recovered < known.shown) known.recovered += 1;
  });
}
