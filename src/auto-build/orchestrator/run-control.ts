/**
 * Pause, Resume and Cancel for a build, from its card in the AGENTS panel (the
 * desktop's and the phone's: chat-ws/agent-controls.ts routes a build's id
 * here). A build is not a canonical-loop op, so the card's Pause used to reach
 * opPause, which knew no such op: "pause failed: unknown_op", and Cancel did
 * nothing at all (2026-11-25).
 *
 *   pause   stops the build at once. The running worker or reviewer is
 *           stopped; the chunk's work so far, what the reviews found and the
 *           round it was on are kept (stopped-run.ts), and the build waits,
 *           through a restart too, until Resume.
 *   resume  starts it again from exactly there (resume.ts startFromSavedState):
 *           same card, same chunk, same round, the finish checks' place.
 *   cancel  ends it, keeping its work the same way; build_plan_resume can
 *           still take it up.
 *
 * What a stopped worker was in the middle of saying is not kept: Resume starts
 * a worker that has the work and the findings, not that conversation.
 */
import { getActive, stopRun } from "./manager.js";
import { listAll } from "./registry.js";
import * as state from "./state.js";
import type { OrchestratorState } from "./state.js";
import { startFromSavedState } from "./resume.js";
import { endStoppedRun } from "./stopped-run.js";

export type BuildAction = "pause" | "resume" | "cancel";
export type BuildControlResult = { ok: true } | { ok: false; message: string };

/** The saved state of a build not running in this process, found by its card's id. */
function savedBuild(opId: string): OrchestratorState | null {
  for (const entry of listAll()) {
    const s = state.read(entry.projectDir);
    if (s?.opId === opId) return s;
  }
  return null;
}

/** Whether a card's id is a build's, running here or kept on disk. */
export function isBuildRun(opId: string): boolean {
  return getActive(opId) !== undefined || savedBuild(opId) !== null;
}

export function controlBuild(opId: string, action: BuildAction): BuildControlResult {
  if (getActive(opId)) {
    if (action === "resume") return { ok: true };
    stopRun(opId, action === "pause" ? "paused" : "cancelled");
    return { ok: true };
  }
  const s = savedBuild(opId);
  if (!s) return { ok: false, message: `no build with id ${opId}` };
  if (action === "pause") {
    return s.phase === "paused" ? { ok: true } : { ok: false, message: `the build is not running (it is ${s.phase})` };
  }
  if (action === "cancel") {
    if (s.phase === "complete") return { ok: false, message: "the build already finished" };
    endStoppedRun({ opId, sessionId: s.sessionId, projectDir: s.projectDir, liveState: s }, "cancelled");
    return { ok: true };
  }
  if (s.phase !== "paused") return { ok: false, message: `the build is ${s.phase}, not paused: ask its chat to resume it` };
  try {
    const started = startFromSavedState(s, s.sessionId);
    return started.kind === "started" ? { ok: true } : { ok: false, message: started.reason };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Paused builds, for the AGENTS panel's snapshot: a card that reads "paused" after a reload or a restart. */
export function listPausedBuilds(): { opId: string; projectDir: string; sessionId: string; startedAt: number }[] {
  const out: { opId: string; projectDir: string; sessionId: string; startedAt: number }[] = [];
  for (const entry of listAll()) {
    const s = state.read(entry.projectDir);
    if (s?.phase === "paused" && !getActive(s.opId)) {
      out.push({ opId: s.opId, projectDir: s.projectDir, sessionId: s.sessionId, startedAt: Date.parse(s.startedAt) || Date.now() });
    }
  }
  return out;
}
