/**
 * Codex Session Registry
 *
 * Tracks state across turns for the Codex Responses API.
 * Sessions are keyed by sessionId and store the previousResponseId
 * needed for incremental mode, plus context length and reasoning
 * items for replay.
 *
 * Singleton Map — no external dependencies, no persistence.
 * Stale sessions (>1 hour) are cleaned up automatically.
 */

// ── Types ──

export interface CodexSession {
  sessionId: string;
  /** Response ID from the last Codex turn (for incremental mode) */
  previousResponseId: string | null;
  /** Message count at last turn — used to detect new messages */
  lastContextLength: number;
  /** Reasoning items to replay on the next turn */
  lastReasoningItems: unknown[];
  createdAt: number;
  lastUsedAt: number;
}

// ── Registry (module-level singleton) ──

const sessions = new Map<string, CodexSession>();

/** Default max age: 1 hour */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

// ── Public API ──

/**
 * Get an existing session or create a fresh one.
 * Accessing a session updates its lastUsedAt timestamp.
 */
export function getOrCreateCodexSession(sessionId: string): CodexSession {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const session: CodexSession = {
    sessionId,
    previousResponseId: null,
    lastContextLength: 0,
    lastReasoningItems: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Partial-update a session. Only the provided fields are merged;
 * lastUsedAt is always bumped.
 */
export function updateCodexSession(
  sessionId: string,
  update: Partial<CodexSession>,
): void {
  const session = sessions.get(sessionId);
  if (!session) return; // Nothing to update — caller should getOrCreate first

  Object.assign(session, update, { lastUsedAt: Date.now() });
}

/**
 * Remove sessions older than maxAgeMs (default 1 hour).
 * Safe to call frequently — iteration over a small Map is cheap.
 */
export function cleanupStaleSessions(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [id, session] of sessions) {
    if (session.lastUsedAt < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[codex-session] Cleaned up ${removed} stale session(s)`);
  }
  return removed;
}

/**
 * Delete a specific session (e.g. on explicit logout or reset).
 */
export function deleteCodexSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

/**
 * Current number of tracked sessions (useful for diagnostics).
 */
export function sessionCount(): number {
  return sessions.size;
}
