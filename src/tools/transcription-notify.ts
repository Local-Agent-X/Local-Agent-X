/**
 * Tell the chat when a recording it asked for is transcribed. A long file on
 * a slow computer takes up to ~15 minutes; instead of the agent sitting in its
 * turn calling transcribe_media again and again, the call answers at once and
 * the chat is woken when the job ends, the way a finished background op is
 * reported (ops/pending-notifications.ts + ops/op-report-wake.ts): the
 * completion is queued for the agent's next turn, then a turn is started for
 * it to read the transcript and carry on with what the user asked.
 *
 * Only a chat a person is in is woken (announceEndedOp checks); an unattended
 * run keeps calling until it has the whole file.
 */

import { basename } from "node:path";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { announceEndedOp, type ReportedStatus } from "../ops/op-report-wake.js";
import type { JobProgress } from "./transcription-job.js";

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** What the chat is told when the job for `path` (from `startSec`) ends. */
export function transcriptionNotice(path: string, startSec: number, p: JobProgress): {
  status: ReportedStatus; summary: string; next: string;
} {
  const read = `transcribe_media(path=${JSON.stringify(path)}, start_at=${startSec})`;
  if (p.complete) {
    return {
      status: "completed",
      summary: `The transcript of ${basename(path)} is ready (to ${clock(p.coveredTo)}).`,
      next: `call ${read}: it returns the saved transcript at once. Then do what the user asked with it.`,
    };
  }
  const why = p.error ? ` (${p.error.slice(0, 160)})` : "";
  return {
    status: "failed",
    summary: `Transcribing ${basename(path)} stopped at ${clock(p.coveredTo)}${why}.`,
    next: `tell the user. Calling transcribe_media(path=${JSON.stringify(path)}, start_at=${Math.floor(p.coveredTo)}) resumes from there; what is done is kept.`,
  };
}

/** Queue the notice for `sessionId` and wake its chat. */
export function announceTranscription(sessionId: string, jobId: string, path: string, startSec: number, p: JobProgress): void {
  const n = transcriptionNotice(path, startSec, p);
  const task = `Transcribing ${basename(path)}`;
  pushPendingNotification(sessionId, {
    opId: jobId, status: n.status, summary: n.summary, filesChanged: [], task,
    completedAt: Date.now(), toolJob: { next: n.next },
  });
  announceEndedOp(sessionId, { opId: jobId, task, status: n.status }, false);
}
