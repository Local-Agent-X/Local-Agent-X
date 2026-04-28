/**
 * In-memory registry of active autopilot sessions, keyed by sessionId.
 *
 * Used by:
 *   - tool-executor.ts to inject internal _cwd into self_edit args
 *   - tool-executor.ts to gate self_edit against maxSelfEditCalls
 *   - autopilot loop to bookkeep per-session counters
 *
 * Lives outside the autopilot module's main control flow so it can be
 * imported by tool-executor without creating a circular dependency.
 */

interface AutopilotSessionEntry {
  opId: string;
  worktreePath: string;
  /** how many times the round agent invoked self_edit so far */
  selfEditCalls: number;
  /** ceiling — when selfEditCalls >= this, tool returns ceiling-reached */
  maxSelfEditCalls: number;
}

const autopilotSessions = new Map<string, AutopilotSessionEntry>();

export function registerAutopilotSession(
  sessionId: string,
  opId: string,
  worktreePath: string,
  maxSelfEditCalls: number,
): void {
  autopilotSessions.set(sessionId, {
    opId,
    worktreePath,
    selfEditCalls: 0,
    maxSelfEditCalls,
  });
}

export function unregisterAutopilotSession(sessionId: string): void {
  autopilotSessions.delete(sessionId);
}

export function isAutopilotSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return autopilotSessions.has(sessionId);
}

export function getAutopilotWorktree(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  return autopilotSessions.get(sessionId)?.worktreePath || null;
}

/**
 * Increment the self_edit counter for a session.
 * Returns { allowed, count, max }. If !allowed, the caller should refuse the call.
 */
export function trackSelfEditCall(sessionId: string): { allowed: boolean; count: number; max: number } {
  const entry = autopilotSessions.get(sessionId);
  if (!entry) return { allowed: true, count: 0, max: Infinity };
  if (entry.selfEditCalls >= entry.maxSelfEditCalls) {
    return { allowed: false, count: entry.selfEditCalls, max: entry.maxSelfEditCalls };
  }
  entry.selfEditCalls++;
  return { allowed: true, count: entry.selfEditCalls, max: entry.maxSelfEditCalls };
}

/** Read-only counter inspect (for summary). */
export function getSelfEditCount(sessionId: string): number {
  return autopilotSessions.get(sessionId)?.selfEditCalls || 0;
}

/**
 * For aggregating across all rounds of one operation. Each round uses a
 * different sessionId; the loop calls this with the previous round's
 * sessionId before unregistering it.
 */
export function snapshotAndReset(sessionId: string): { selfEditCalls: number } {
  const entry = autopilotSessions.get(sessionId);
  if (!entry) return { selfEditCalls: 0 };
  return { selfEditCalls: entry.selfEditCalls };
}
