import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore, MemoryIndex } from "../../memory/index.js";
import { isExcludedFromSessionSummaries } from "../../memory/synthetic-sessions.js";
import { createLogger } from "../../logger.js";
import { userAuthoredRows } from "../../harness-rows.js";

const logger = createLogger("server.background-jobs.memory-bg");

// Stored facts the supersede sweep examines per run (memory-bg polls every
// 6h): a backlog of a few thousand clears in about a week, one resolver call
// each, and new facts are taken first.
const SUPERSEDE_PER_RUN = 150;

export interface MemoryBgDeps {
  dataDir: string;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
}

export function makeRunMemBg(deps: MemoryBgDeps): () => Promise<void> {
  const { dataDir, sessionStore, memoryIndex } = deps;
  let recoveryReported = false;
  return async () => {
    // First, before anything below changes memory: today's snapshot of the
    // facts nothing can rebuild (memory/db-backup.ts).
    try {
      const { inboxMemoryAlert } = await import("../../inbox/producers.js");
      if (memoryIndex.recovery && !recoveryReported) {
        recoveryReported = true;
        const { movedTo, restored } = memoryIndex.recovery;
        inboxMemoryAlert({
          key: "memory-recovery",
          title: restored ? "Memory was restored from a backup" : "Memory could not be opened and started empty",
          body: (restored
            ? `The memory database could not be opened at start. ${restored.facts} memories were restored from ${restored.from}; anything saved after that backup is not in it.`
            : "The memory database could not be opened at start, and no backup passed its checks, so memory started empty.")
            + ` The unreadable file was kept at ${movedTo}.`,
        });
      }
      const snap = memoryIndex.snapshotFacts();
      if (snap.status === "written") logger.info(`[memory-bg] Snapshot: ${snap.facts} facts → ${snap.path}`);
      if (snap.status === "failed") {
        logger.warn(`[memory-bg] Snapshot failed: ${snap.error}`);
        inboxMemoryAlert({ key: "memory-snapshot", title: "Today's memory backup failed", body: `The daily backup of your memories could not be written or did not pass its checks: ${snap.error}` });
      }
    } catch (e) { logger.warn("[memory-bg] Snapshot:", (e as Error).message); }
    try { const { MemoryOrchestrator: MO } = await import("../../orchestrator/orchestrator.js"); const r = MO.getInstance().runBackground(memoryIndex); logger.info(`[memory-bg] ${r.totalTimeMs}ms`); } catch (e) { logger.warn("[memory-bg]", (e as Error).message); }
    // Consolidation stages via the shared pipeline: algorithmic consolidate,
    // the supersede sweep (memory keeps itself current — the owner's call,
    // 2026-11-04: stale facts are replaced by newer ones automatically, kept
    // as history), and reflect. Extract is left off here — it stays
    // user-triggered through the memory_consolidate/memory_dream tools.
    try {
      const { runConsolidation } = await import("../../memory/consolidation-pipeline.js");
      const { consolidation, reflection, supersession } = await runConsolidation(memoryIndex, { consolidate: true, supersede: SUPERSEDE_PER_RUN, reflect: 7 });
      if (supersession && supersession.replaced > 0) {
        logger.info(`[memory-bg] Supersede: ${supersession.replaced} replaced of ${supersession.examined} examined${supersession.backlogLeft ? " (backlog left)" : ""}`);
      }
      if (reflection && (reflection.entitiesUpdated.length > 0 || reflection.opinionsUpdated > 0)) {
        logger.info(`[memory-bg] Reflect: ${reflection.entitiesUpdated.length} entities, ${reflection.opinionsUpdated} opinions`);
      }
      if (consolidation && (consolidation.mergedCount > 0 || consolidation.promotedCount > 0)) {
        logger.info(`[memory-bg] Consolidation: merged=${consolidation.mergedCount} promoted=${consolidation.promotedCount}`);
      }
    } catch (e) { logger.warn("[memory-bg] Consolidation:", (e as Error).message); }
    try {
      // Internal scratch (dream-/cron-/eval_/skill-review-) never enters
      // session summaries — a chatty cron transcript is not user memory, and
      // universal-index embeds every summary written here. ide- IS
      // summarized (real user conversations; see the re-summarize comment
      // below). One predicate — memory/synthetic-sessions.ts.
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000, recent = sessionStore.list().filter(s => s.updatedAt > cutoff && s.messageCount > 2 && !isExcludedFromSessionSummaries(s.id));
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
        // userAuthoredRows: a harness row (nudge, carried recall) is not something the user said.
        const userMsgs = userAuthoredRows(sess.messages).filter(m => m.role === "user" && typeof m.content === "string").map(m => (m.content as string).slice(0, 200));
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
    try {
      // Warm the atlas layout so the Memory tab's brain graph renders instantly
      // on first view instead of making the visitor wait 3-20s for the JL→PCA→
      // k-means compute. This runs at boot+30s (first scheduler tick) and after
      // each 6h consolidation — the consolidation above can change chunks, which
      // changes the atlas signature, so we recompute here off the request path.
      // No-op cost when the signature is unchanged: atlasLayout() returns the
      // already-cached layout without recomputing.
      const t = Date.now();
      const layout = await memoryIndex.atlasLayout();
      if (layout) logger.info(`[memory-bg] Atlas warm: ${layout.ids.length} pts, ${layout.clusters.length} clusters (${Date.now() - t}ms)`);
    } catch (e) { logger.warn("[memory-bg] Atlas warm:", (e as Error).message); }
  };
}
