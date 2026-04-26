import { join } from "node:path";
import type { SessionStore, MemoryIndex } from "../memory.js";
import type { Session } from "../types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.session-helpers");

export interface SessionHelpers {
  sessions: Map<string, Session>;
  getOrCreateSession: (id: string) => Session;
  saveSession: (session: Session) => void;
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
  const sessionIndexedPairs = new Map<string, number>();

  function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (s) { sessions.delete(id); sessions.set(id, s); return s; }
    s = sessionStore.load(id) ?? undefined;
    if (s) { sessions.set(id, s); if (sessions.size > maxCached) sessions.delete(sessions.keys().next().value!); return s; }
    s = { id, title: "New Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(id, s); if (sessions.size > maxCached) sessions.delete(sessions.keys().next().value!); return s;
  }

  function saveSession(session: Session): void {
    const prev = writeQueues.get(session.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      sessions.set(session.id, session);
      sessionStore.save(session);
      memoryIndex.markDirty();
      try { await indexSessionIncrementally(session); } catch (e) { logger.warn(`[memory] Incremental index failed:`, (e as Error).message); }
    }).catch(e => logger.error(`[session] Save failed:`, e));
    writeQueues.set(session.id, next);
    next.finally(() => { if (writeQueues.get(session.id) === next) writeQueues.delete(session.id); });
  }

  async function indexSessionIncrementally(session: Session): Promise<void> {
    if (session.id.startsWith("dream-") || session.id.startsWith("ide-")) return;
    logger.info(`[memory-live] Indexing session ${session.id} (${session.messages?.length || 0} messages)`);
    const { extractSessionPairs, chunkConversationPairs } = await import("../memory-chunking.js");
    const messages = extractSessionPairs(join(dataDir, "sessions", session.id + ".json"));
    if (messages.length < 2) return;

    const pairs: Array<{ user: string; assistant: string }> = [];
    let i = 0;
    while (i < messages.length) {
      if (messages[i].role === "user") {
        const userContent = messages[i].content;
        let assistantContent = "";
        i++;
        while (i < messages.length && messages[i].role === "assistant") {
          assistantContent += (assistantContent ? "\n\n" : "") + messages[i].content;
          i++;
        }
        if (assistantContent) pairs.push({ user: userContent, assistant: assistantContent });
      } else { i++; }
    }

    const alreadyIndexed = sessionIndexedPairs.get(session.id) || 0;
    if (pairs.length <= alreadyIndexed) return;

    const newPairs = pairs.slice(alreadyIndexed);
    const newMessages = newPairs.flatMap(p => [
      { role: "user" as const, content: p.user },
      { role: "assistant" as const, content: p.assistant },
    ]);

    const sessionDate = session.createdAt ? new Date(session.createdAt).toISOString().split("T")[0] : undefined;
    const metadata = { source_type: "agent-x-session" as const, session_id: session.id, date: sessionDate };
    const virtualPath = `session-live/${session.id}/${pairs.length}`;
    const chunks = chunkConversationPairs(newMessages, virtualPath, "session", metadata);

    if (chunks.length > 0) {
      await memoryIndex.indexChunks(chunks, virtualPath, "session");
      sessionIndexedPairs.set(session.id, pairs.length);
      logger.info(`[memory-live] Indexed ${chunks.length} new chunks from ${newPairs.length} pairs (session ${session.id}, total pairs: ${pairs.length})`);
    } else {
      logger.info(`[memory-live] No new pairs to index for ${session.id}`);
    }
  }

  return { sessions, getOrCreateSession, saveSession };
}
