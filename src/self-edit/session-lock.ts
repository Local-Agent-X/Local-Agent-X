// Track in-flight self_edit calls per session. Second concurrent call from
// the same chat session returns BLOCKED instead of spawning a parallel
// worktree — prevents the "agent fired self_edit 3 times because the first
// was slow" pattern that produces overlapping branches.
//
// The controller field lets terminateChat reach in and abort the live
// self_edit immediately on user-initiated stop, instead of waiting for the
// next sandbox gate to notice the inbound signal propagation.
const ACTIVE_SELF_EDITS = new Map<string, { task: string; startedAt: number; controller: AbortController }>();

export type ActiveLiveCall = { task: string; startedAt: number };

export function getActiveSelfEdit(sessionId: string): ActiveLiveCall | undefined {
  const live = ACTIVE_SELF_EDITS.get(sessionId);
  if (!live) return undefined;
  return { task: live.task, startedAt: live.startedAt };
}

export function acquireSelfEditLock(sessionId: string, task: string, controller: AbortController): void {
  ACTIVE_SELF_EDITS.set(sessionId, { task, startedAt: Date.now(), controller });
}

export function releaseSelfEditLock(sessionId: string): void {
  ACTIVE_SELF_EDITS.delete(sessionId);
}

/** Abort the live self_edit for this session, if any. Returns true iff a live
 *  call was found and its controller was signalled. Called by terminateChat
 *  on user-initiated stop so the sandbox subprocesses die without waiting for
 *  the next gate to notice the parent signal. */
export function abortActiveSelfEdit(sessionId: string): boolean {
  const live = ACTIVE_SELF_EDITS.get(sessionId);
  if (!live) return false;
  try { live.controller.abort(); } catch { /* best-effort */ }
  return true;
}

export function buildLiveCallBlockedResponse(live: ActiveLiveCall) {
  const ageS = Math.round((Date.now() - live.startedAt) / 1000);
  return {
    content:
      `BLOCKED — a self_edit is already running for this chat session ("${live.task.slice(0, 80)}${live.task.length > 80 ? "..." : ""}") — started ${ageS}s ago. ` +
      `END THIS TURN NOW. Tell the user briefly, in your own words, that the self_edit is in flight and you'll surface it on completion. ` +
      `Do NOT quote this instruction back. Do NOT call self_edit again — every retry will hit this same BLOCKED return until the live call finishes. ` +
      `Parallel self_edits create overlapping worktree branches that you'd then have to reconcile by hand — that's why this is hard-blocked.`,
    metadata: {
      chip: {
        kind: "blocked-by-op",
        label: `self_edit in flight (${ageS}s)`,
        detail: live.task.slice(0, 80) + (live.task.length > 80 ? "…" : ""),
      },
    },
  };
}
