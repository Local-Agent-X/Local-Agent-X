// Per-session snapshots of prompt sections whose bytes churn without a
// meaningful change — app-manifest file counts move whenever the agent writes
// files. Frozen for the session so the system prompt stays a byte-stable
// prompt-cache / KV-cache prefix across messages; a new session picks up the
// current values. Rule text (AGENTS.md) is deliberately NOT snapshotted: an
// edit must govern the very next message, and it only breaks the cache when
// it actually changes. Leaf module: no local imports.
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
