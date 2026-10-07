import { join } from "node:path";
import type { SessionStore, MemoryIndex } from "../memory/index.js";
import type { Session } from "../types.js";
import { setSessionProject } from "../session/project.js";
import { isSyntheticSessionId } from "../memory/synthetic-sessions.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.session-helpers");

export interface SessionHelpers {
  sessions: Map<string, Session>;
  getOrCreateSession: (id: string) => Session;
  /**
   * Queue a session write. Returns a Promise that resolves when the write
   * (cache update + disk + memory index) has finished. Callers may
   * fire-and-forget by ignoring the return value. The next turn that
   * needs to read this session should `await flushSession(id)` first.
   */
  saveSession: (session: Session) => Promise<void>;
  /**
   * Wait for any pending write for this session to complete. No-op if
   * nothing is queued. Call this at the start of a request that depends
   * on the prior turn's bytes being durable (cache + disk).
   *
   * Invariant: any reader that consumes `session.messages` as the committed
   * transcript MUST `await flushSession(id)` first. The bridge writer
   * (canonical-run.ts:persistTurnState) assigns `session.messages` and then
   * `saveSession`s in one synchronous stretch, so awaiting the queued write
   * guarantees the assignment has landed. Skipping this reintroduces the
   * 2026-05-19 hazard: a fast next-turn / inject / compaction read the stale
   * cache (or stale disk bytes after LRU eviction) before the bridge flushed,
   * reordering or dropping the latest turn.
   */
  flushSession: (id: string) => Promise<void>;
}

export function createSessionHelpers(deps: {
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  dataDir: string;
  maxCached: number;
}): SessionHelpers {
  const { sessionStore, memoryIndex, dataDir, maxCached } = deps;
  const sessions = new Map<string, Session>();
  const writeQueues = new Map<string, Promise<void>>();

  function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (s) { sessions.delete(id); sessions.set(id, s); return s; }
    s = sessionStore.load(id) ?? undefined;
    if (s) {
      // Seed the in-memory project map from the durable field so agent_*
      // spawns auto-scope even on a cold session (heartbeat/scheduled runs
      // that never replay an incoming msg.projectId). The map is a cache of
      // this field; the chat turn refreshes it from the live request.
      if (s.projectId) setSessionProject(s.id, s.projectId);
      sessions.set(id, s); if (sessions.size > maxCached) sessions.delete(sessions.keys().next().value!); return s;
    }
    s = { id, title: "New Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(id, s); if (sessions.size > maxCached) sessions.delete(sessions.keys().next().value!); return s;
  }

  function saveSession(session: Session): Promise<void> {
    const prev = writeQueues.get(session.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      sessions.set(session.id, session);
      sessionStore.save(session);
      memoryIndex.markDirty();
      try { await indexSessionIncrementally(session); } catch (e) { logger.warn(`[memory] Incremental index failed:`, (e as Error).message); }
    }).catch(e => logger.error(`[session] Save failed:`, e));
    writeQueues.set(session.id, next);
    next.finally(() => { if (writeQueues.get(session.id) === next) writeQueues.delete(session.id); });
    return next;
  }

  async function flushSession(id: string): Promise<void> {
    const pending = writeQueues.get(id);
    if (pending) await pending;
  }

  // After a save, (re)index the session file through the one session-chunk
  // builder — the same chunks, provenance and path the sync pass writes.
  // Idempotent: only an exchange whose text is new is embedded, and an
  // unchanged one only has its metadata refreshed. This used to pair and
  // date the session itself and write each new exchange a second time under
  // a virtual session-live/ path.
  async function indexSessionIncrementally(session: Session): Promise<void> {
    if (isSyntheticSessionId(session.id)) return;
    const { buildSessionChunks } = await import("../memory/chunking.js");
    const path = join(dataDir, "sessions", session.id + ".jsonl");
    const chunks = buildSessionChunks(path, session.id);
    if (chunks.length === 0) return;
    const r = await memoryIndex.indexChunksIdempotent(chunks, path, "session");
    if (r.added > 0) logger.info(`[memory-live] Indexed ${r.added} new chunks (session ${session.id})`);
  }

  return { sessions, getOrCreateSession, saveSession, flushSession };
}
