// Per-session snapshots of sections read from disk that the agent's own writes
// churn (app-manifest file counts, AGENTS.md). Frozen for the session so the
// system prompt stays a byte-stable prompt-cache / KV-cache prefix across
// messages; a new session picks up the current files. self_edit re-reads
// AGENTS.md itself (self-edit/agents-rules.ts), so edits still govern edits.
// Leaf module: no local imports.
const SESSION_SNAPSHOT_MAX_SESSIONS = 500;
const sessionSnapshots = new Map<string, Map<string, string>>();

export async function snapshotForSession(
  sessionId: string | undefined,
  sectionId: string,
  read: () => Promise<string>,
): Promise<string> {
  if (!sessionId) return read();
  let sections = sessionSnapshots.get(sessionId);
  const cached = sections?.get(sectionId);
  if (cached !== undefined) return cached;
  const text = await read();
  if (!sections) {
    if (sessionSnapshots.size >= SESSION_SNAPSHOT_MAX_SESSIONS) {
      sessionSnapshots.delete(sessionSnapshots.keys().next().value as string);
    }
    sections = new Map();
    sessionSnapshots.set(sessionId, sections);
  }
  sections.set(sectionId, text);
  return text;
}

export function _resetSessionSnapshotsForTests(): void {
  sessionSnapshots.clear();
}
