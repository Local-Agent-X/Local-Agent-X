/**
 * Per-session current-project context.
 *
 * The user's active chat may be nested under a Project. When Primal
 * spawns an agent from that chat, the spawn should be scoped to the
 * project's roster (Q3 + Q4 from canonical-agent-design.md). Rather
 * than thread projectId through every layer (chat WS → agent loop →
 * tool executor → tool args), we keep a tiny map keyed by sessionId
 * and have the tool executor inject `project_id` into agent_* tool
 * args when one is set for the current session.
 *
 * Storage is in-memory only — projects live in the backend store and
 * the active selection is per-tab/per-session, not durable.
 */

const currentProjectBySession = new Map<string, string>();

/** Set or clear the current project for a session. Pass a falsy
 *  projectId to clear (e.g. user moved a chat out of any project). */
export function setSessionProject(sessionId: string, projectId: string | null | undefined): void {
  if (!sessionId) return;
  if (projectId && typeof projectId === "string" && projectId.length > 0) {
    currentProjectBySession.set(sessionId, projectId);
  } else {
    currentProjectBySession.delete(sessionId);
  }
}

/** Read the current project for a session. Returns undefined when
 *  the chat isn't nested under any project. */
export function getSessionProject(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  return currentProjectBySession.get(sessionId);
}

/** Test-only: reset the map so fixtures don't bleed. */
export function _resetSessionProjectsForTest(): void {
  currentProjectBySession.clear();
}
