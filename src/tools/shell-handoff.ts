/**
 * "Send now": a message the user typed while the agent waits on a shell
 * command is read now, and the command keeps running.
 *
 * A message typed mid-turn is read at the agent's next step, after every tool
 * call of the current one has returned; a ten-minute polling loop kept "are
 * you stuck?" unread for ten minutes (2026-11-22). The user's Send now moves
 * each shell command the chat is waiting on into a process session (the same
 * kind process_start makes): the bash call returns at once with the output so
 * far, the agent's next step reads the message, and process_status reaches the
 * command when the agent wants its result. The command keeps its timeout.
 *
 * Only bash calls register; a run whose output is withheld or scrubbed for a
 * vault secret does not (its output rules live in the run), and neither does
 * any other tool: for those the message is read when the step ends.
 */
import type { ToolResult } from "../types.js";
import type { CagedHandoffOutcome } from "./caged-spawn.js";
import { adoptSession, tailLines } from "./process-session.js";
import { running } from "./result-helpers.js";

const WAITING = new Map<string, Set<AbortController>>();

/** A bash call the chat `sessionId` is waiting on: `signal` fires when the
 *  user sends a message now. `release` once the run settles, either way. */
export function holdForSendNow(sessionId: string | undefined): { signal?: AbortSignal; release: () => void } {
  if (!sessionId) return { release: () => {} };
  const hold = new AbortController();
  const held = WAITING.get(sessionId) ?? new Set<AbortController>();
  held.add(hold);
  WAITING.set(sessionId, held);
  return {
    signal: hold.signal,
    release: () => {
      held.delete(hold);
      if (held.size === 0 && WAITING.get(sessionId) === held) WAITING.delete(sessionId);
    },
  };
}

/** Move every shell command chat `sessionId` waits on to the background.
 *  Returns how many were moved: 0 means the agent is on another kind of step,
 *  and reads the message when that step ends. */
export function sendNow(sessionId: string): number {
  const held = WAITING.get(sessionId);
  if (!held) return 0;
  WAITING.delete(sessionId);
  for (const hold of held) hold.abort();
  return held.size;
}

/** The bash result for a command moved to the background: what it printed so
 *  far, and how to reach it. */
export function movedToBackgroundResult(
  run: CagedHandoffOutcome,
  command: string,
  cwd: string,
  timeoutMs: number,
): ToolResult {
  const startedAt = Date.now() - run.durationMs;
  const session = adoptSession(run.child, command, cwd, run.captured, startedAt, startedAt + timeoutMs);
  const soFar = tailLines((run.captured.stdout + (run.captured.stderr ? `\n[stderr]\n${run.captured.stderr}` : "")).trim(), 40);
  const id = session.sessionId;
  return running(
    id,
    `[Still running. The user sent a message and asked you to read it now, so after ${Math.round(run.durationMs / 1000)}s this command ` +
    `moved to the background as process session ${id}; it keeps running until it ends or its ${Math.round(timeoutMs / 1000)}s timeout. ` +
    `Read the user's message and answer it, then get this command's result with process_status({"session_id": "${id}"}). ` +
    `Do not run it again: it is still going.]\n\nOutput so far:\n${soFar || "(none yet)"}`,
    { moved_to_background: true, duration_ms: run.durationMs },
  );
}
