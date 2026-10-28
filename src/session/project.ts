/**
 * Per-session current-project context.
 *
 * The user's active chat may be nested under a Project. When the chat agent
 * spawns an agent from that chat, the spawn should be scoped to the
 * project's roster (Q3 + Q4 from docs/history/canonical-agent-design.md). Rather
 * than thread projectId through every layer (chat WS → agent loop →
 * tool executor → tool args), we keep a tiny map keyed by sessionId
 * and have the tool executor inject `project_id` into agent_* tool
 * args when one is set for the current session.
 *
 * The map is a cache of each saved session's `projectId`: seeded from the
 * session list at startup and per session when one is loaded, refreshed by
 * every chat turn.
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

/** Load every saved chat's project at startup, before anything resumes. A
 *  worker restored after a restart takes its project from its parent chat
 *  here, and that chat may not be opened again until long after. */
export function seedSessionProjects(sessions: Iterable<{ id: string; projectId?: string }>): void {
  for (const s of sessions) if (s.projectId) setSessionProject(s.id, s.projectId);
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
