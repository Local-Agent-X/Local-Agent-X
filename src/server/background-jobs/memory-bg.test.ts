/**
 * memory-bg summarization seam — the FOURTH reader of the synthetic set.
 *
 * memory-bg used to summarize ANY recent session with messageCount > 2 into
 * memory/session-summaries, which universal-index then embeds. A chatty
 * cron-/dream-/eval_/skill-review- transcript therefore leaked into the
 * memory index and the summaries surface — the same class as dream's 150 MB
 * self-ingestion. The fix routes the seam through the one classifier in
 * memory/synthetic-sessions.ts (isExcludedFromSessionSummaries).
 *
 * ide- is the load-bearing exception: `ide-{appId}` chats are real user
 * build/fix conversations and the mtime-vs-updatedAt re-summarize below the
 * seam exists precisely for them — they must KEEP summarizing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomId } from "../../util/ids.js";
import type { SessionStore, MemoryIndex } from "../../memory/index.js";
import type { Session } from "../../types.js";
import { makeRunMemBg } from "./memory-bg.js";

const indexedSummaries = vi.hoisted(() => [] as string[]);

// The job's other stages (orchestrator, consolidation, universal-index) are
// dynamic imports with their own try/catch — mocked so this test exercises
// only the summarize seam, deterministically.
vi.mock("../../orchestrator/orchestrator.js", () => ({
  MemoryOrchestrator: { getInstance: () => ({ runBackground: () => ({ totalTimeMs: 0 }) }) },
}));
vi.mock("../../memory/consolidation-pipeline.js", () => ({
  runConsolidation: async () => ({ consolidation: null, reflection: null }),
}));
vi.mock("../../memory/universal-index.js", () => ({
  getUniversalIndex: () => ({
    indexSessionSummary: async (id: string) => { indexedSummaries.push(id); return { added: 0, removed: 0, unchanged: 0 }; },
  }),
}));

let dataDir: string;
let loaded: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-memory-bg-"));
  loaded = [];
  indexedSummaries.length = 0;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeDeps(ids: string[]) {
  const metas = ids.map(id => ({ id, title: `t-${id}`, updatedAt: Date.now(), messageCount: 3 }));
  const sessionStore = {
    list: () => metas.slice(),
    load: (id: string): Session => {
      loaded.push(id);
      return {
        id,
        title: `t-${id}`,
        messages: [
          { role: "user", content: `hello from ${id}` },
          { role: "assistant", content: `reply for ${id}` },
          { role: "user", content: "and more" },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
  } as unknown as SessionStore;
  const memoryIndex = {
    purgeInvalidatedFacts: () => 0,
    atlasLayout: async () => null,
  } as unknown as MemoryIndex;
  return { dataDir, sessionStore, memoryIndex };
}

describe("memory-bg summarization — synthetic sessions stay out of session summaries", () => {
  it("summarizes chat- and ide- sessions; skips cron-/dream-/eval_/skill-review- without even loading them", async () => {
    const evalId = randomId("eval"); // the real minter (routes/chat.ts)
    const run = makeRunMemBg(makeDeps([
      "chat-aaa",
      "ide-app1", // MUST keep summarizing — real user conversations
      `cron-daily-report-${Date.now()}`, // real minter shape (cron-runner.ts)
      "dream-1780687489740",
      evalId,
      "skill-review-1756687489740-0",
    ]));

    await run();

    const written = readdirSync(join(dataDir, "memory", "session-summaries")).sort();
    expect(written).toEqual(["chat-aaa.md", "ide-app1.md"]);
    // Synthetic transcripts are never even loaded — they'd otherwise burn
    // the slice(0, 30) per-run budget and starve real sessions.
    expect(loaded.sort()).toEqual(["chat-aaa", "ide-app1"]);
    // And only real summaries reach the universal index (what gets embedded).
    expect(indexedSummaries.sort()).toEqual(["chat-aaa", "ide-app1"]);
  });

  it("near-miss ids are NOT skipped (prefix must be leading and exact)", async () => {
    const run = makeRunMemBg(makeDeps(["my-cron-job", "dreamer", "skill-reviewer"]));

    await run();

    const written = readdirSync(join(dataDir, "memory", "session-summaries")).sort();
    expect(written).toEqual(["dreamer.md", "my-cron-job.md", "skill-reviewer.md"]);
  });
});
