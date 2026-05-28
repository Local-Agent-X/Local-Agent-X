import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore, MemoryIndex } from "../../memory/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("server.background-jobs.memory-bg");

export interface MemoryBgDeps {
  dataDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
}

export function makeRunMemBg(deps: MemoryBgDeps): () => Promise<void> {
  const { dataDir, sessionStore, memoryIndex } = deps;
  return async () => {
    try { const { MemoryOrchestrator: MO } = await import("../../memory-orchestrator.js"); const r = MO.getInstance().runBackground(memoryIndex); logger.info(`[memory-bg] ${r.totalTimeMs}ms`); } catch (e) { logger.warn("[memory-bg]", (e as Error).message); }
    try {
      const reflectResult = await memoryIndex.reflect(7);
      if (reflectResult.entitiesUpdated.length > 0 || reflectResult.opinionsUpdated > 0) {
        logger.info(`[memory-bg] Reflect: ${reflectResult.entitiesUpdated.length} entities, ${reflectResult.opinionsUpdated} opinions`);
      }
    } catch (e) { logger.warn("[memory-bg] Reflect:", (e as Error).message); }
    try {
      const { MemoryConsolidator: MC } = await import("../../memory-consolidation/index.js");
      const report = MC.getInstance().consolidate();
      if (report.mergedCount > 0 || report.promotedCount > 0) {
        logger.info(`[memory-bg] Consolidation: merged=${report.mergedCount} promoted=${report.promotedCount} entities=${report.entityPagesUpdated}`);
      }
    } catch (e) { logger.warn("[memory-bg] Consolidation:", (e as Error).message); }
    try {
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000, recent = sessionStore.list().filter(s => s.updatedAt > cutoff && s.messageCount > 2);
      const dir = join(dataDir, "memory", "session-summaries"); mkdirSync(dir, { recursive: true }); let n = 0;
      const newlySummarized: string[] = [];
      for (const meta of recent.slice(0, 30)) {
        const sf = join(dir, `${meta.id}.md`);
        // Re-summarize when the session has been updated since the last
        // summary was written. Without this, stable-id sessions (e.g.
        // `ide-{appId}` IDE chats that accumulate forever) get captured
        // exactly once and then go stale — every subsequent build/fix
        // conversation on the same app fails to make it into memory.
        // mtime-vs-updatedAt is the cheapest accurate signal: one statSync,
        // no extra state to track.
        if (existsSync(sf)) {
          try {
            if (statSync(sf).mtimeMs >= meta.updatedAt) continue;
          } catch { continue; }
        }
        const sess = sessionStore.load(meta.id);
        if (!sess) continue;
        const userMsgs = sess.messages.filter(m => m.role === "user" && typeof m.content === "string").map(m => (m.content as string).slice(0, 200));
        const agentMsgs = sess.messages.filter(m => m.role === "assistant" && typeof m.content === "string").map(m => (m.content as string).split("\n").filter(l => l.trim())[0]?.slice(0, 200) || "");
        const summary = `# ${sess.title}\n\nDate: ${new Date(sess.createdAt).toISOString().split("T")[0]}\nMessages: ${sess.messages.length}\n\n## Key Exchanges\n${userMsgs.slice(0, 10).map((u, i) => `- User: ${u}\n  Agent: ${agentMsgs[i] || "..."}`).join("\n")}\n`;
        writeFileSync(sf, summary, "utf-8");
        n++;
        newlySummarized.push(meta.id);
      }
      if (n > 0) logger.info(`[memory-bg] Summarized ${n} sessions`);
      if (newlySummarized.length > 0) {
        try {
          const { getUniversalIndex } = await import("../../memory/universal-index.js");
          const ui = getUniversalIndex();
          if (ui) for (const id of newlySummarized) await ui.indexSessionSummary(id);
        } catch (e) { logger.warn("[memory-bg] Summary reindex:", (e as Error).message); }
      }
    } catch (e) { logger.warn("[memory-bg] Summarization:", (e as Error).message); }
  };
}
