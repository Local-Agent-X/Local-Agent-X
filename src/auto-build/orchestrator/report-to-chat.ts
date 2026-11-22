/**
 * Telling the chat that started a build how it ended, so its agent picks the
 * run back up at once instead of polling for it.
 *
 * The build's end was only a UI event (bg_op_completed) that the model never
 * saw, so an agent told to see the build through ran `sleep` and `git log` in
 * a loop, holding its turn for the whole run (label-check, 2026-11-21). Now
 * the result goes into the chat's pending queue, which its next prompt drains,
 * and the chat is woken to act on it (ops/op-report-wake.ts, the wake every
 * background job uses). A chat mid-turn is woken when that turn ends.
 *
 * The queue shows a notice's first 180 characters, so the notice leads with
 * what the agent must act on (how far the run got, why it stopped) and names
 * the call that has the rest.
 */
import { basename } from "node:path";
import { pushPendingNotification } from "../../ops/pending-notifications.js";
import { announceEndedOp } from "../../ops/op-report-wake.js";

export interface BuildEnd {
  sessionId: string;
  opId: string;
  projectDir: string;
  chunksCommitted: number;
  totalChunks: number;
  /** Set when the run stopped short: the chunk it stopped at, and why. */
  halt?: { chunk: number; reason: string };
  filesChanged: string[];
}

/** A project folder spelled with forward slashes, whichever computer wrote
 *  it: the spelling a tool call takes, and the one `basename` splits on every
 *  platform (on Linux it does not split a Windows path at "\\"). */
function portablePath(dir: string): string {
  return dir.replace(/\\/g, "/");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The notice's two lines: what happened, and what to call next. */
export function buildEndNotice(end: BuildEnd): { summary: string; next: string } {
  const dir = JSON.stringify(portablePath(end.projectDir));
  const landed = `${end.chunksCommitted}/${end.totalChunks} chunks landed.`;
  if (!end.halt) {
    return { summary: `${landed} The build finished.`, next: "carry on with the step that follows the build." };
  }
  return {
    summary: `${landed} Halted at chunk ${end.halt.chunk}: ${oneLine(end.halt.reason)}`,
    next:
      `build_plan_status(project_dir=${dir}) has the full halt reason. Fix what halted it, or park it for the owner ` +
      `if it is theirs to decide, then build_plan_resume(project_dir=${dir}).`,
  };
}

export function reportBuildToChat(end: BuildEnd): void {
  const task = `The build of ${basename(portablePath(end.projectDir))} (run_build_plan)`;
  const status = end.halt ? "failed" : "completed";
  const notice = buildEndNotice(end);
  pushPendingNotification(end.sessionId, {
    opId: end.opId, status, summary: notice.summary, filesChanged: end.filesChanged, task,
    completedAt: Date.now(), toolJob: { next: notice.next },
  });
  announceEndedOp(end.sessionId, { opId: end.opId, task, status }, false);
}
