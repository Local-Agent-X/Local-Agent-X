/**
 * What happens to a session log another machine wrote once sync lands it
 * here. Three things used to happen: nothing, nothing, and nothing. The file
 * sat in `sessions/` outside the store's list cache (so it was never
 * summarised), outside the memory index until something unrelated marked it
 * dirty, and outside the universal index until the next full scan. The
 * agent's `search_past_sessions` therefore missed it, and the reviewer fork
 * tried to teach the agent to grep the raw jsonl instead.
 */
import type { SessionStore } from "../memory/session-store.js";
import type { MemoryIndex } from "../memory/index-core.js";
import { getUniversalIndex } from "../memory/universal-index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("sync.sessions");

export interface PulledSessionSinks {
  sessionStore: Pick<SessionStore, "adopt">;
  memoryIndex: Pick<MemoryIndex, "markDirty">;
}

export function adoptPulledSessions(sessionIds: readonly string[], sinks: PulledSessionSinks): void {
  sinks.sessionStore.adopt(sessionIds);
  sinks.memoryIndex.markDirty();
  const universal = getUniversalIndex();
  if (universal) {
    for (const id of sessionIds) {
      void universal.indexSessionTranscript(id).catch((e: unknown) => {
        logger.warn(`[sync] could not index pulled session ${id}: ${(e as Error).message}`);
      });
    }
  }
  logger.info(`[sync] adopted ${sessionIds.length} pulled session(s)`);
}
