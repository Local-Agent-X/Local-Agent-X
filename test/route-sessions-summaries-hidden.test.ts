import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import { randomId } from "../src/util/ids.js";

// Session summaries are memory ingestion: memory-bg writes
// memory/session-summaries/<id>.md and universal-index embeds every file in
// that dir. Neither /api/sessions/summaries (reader) nor
// /api/sessions/auto-summarize (the second writer) filtered synthetic
// sessions, so cron-/dream-/eval_/skill-review- scratch surfaced as user
// memory — and files written BEFORE memory-bg learned to skip them are still
// on disk. Both ends now route through isExcludedFromSessionSummaries
// (memory/synthetic-sessions.ts). ide- summaries are real user memory
// (IDE-panel conversations) and stay served/written.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "lax-summaries-route-"));
  dirs.push(dataDir);
  return dataDir;
}

describe("GET /api/sessions/summaries — pre-existing synthetic summary files never surface", () => {
  it("serves chat-/ide- summaries, filters cron-/dream-/eval_/skill-review- files already on disk", async () => {
    const dataDir = makeDataDir();
    const summaryDir = join(dataDir, "memory", "session-summaries");
    mkdirSync(summaryDir, { recursive: true });
    const evalId = randomId("eval"); // the real minter (routes/chat.ts)
    for (const id of [
      "chat-aaa",
      "ide-app1",
      `cron-daily-report-${Date.now()}`,
      "dream-1780687489740",
      evalId,
      "skill-review-1756687489740-0",
      "skill-reviewer", // near-miss: prefix must be leading and exact
    ]) {
      writeFileSync(join(summaryDir, `${id}.md`), `# t-${id}\n\nbody of ${id}\n`, "utf-8");
    }
    const ctx = { dataDir } as unknown as ServerContext;
    const url = new URL("http://test/api/sessions/summaries");
    const cap = mockResponse();

    const handled = await handleSessionRoutes("GET", url, mockJsonRequest({}), cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body) as { summaries: Array<{ id: string }> };
    expect(body.summaries.map(s => s.id).sort()).toEqual(["chat-aaa", "ide-app1", "skill-reviewer"]);
  });
});

describe("POST /api/sessions/auto-summarize — the second writer skips synthetic sessions", () => {
  it("writes summaries only for real stale chats; synthetic transcripts are never loaded", async () => {
    const dataDir = makeDataDir();
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const ids = ["chat-old", `cron-daily-report-${stale}`, "dream-1780687489740", "skill-review-1756687489740-0"];
    const loaded: string[] = [];
    const ctx = {
      dataDir,
      sessionStore: {
        list: vi.fn(() => ids.map(id => ({ id, title: `t-${id}`, updatedAt: stale, messageCount: 5 }))),
        load: vi.fn((id: string) => {
          loaded.push(id);
          return {
            id,
            title: `t-${id}`,
            messages: [{ role: "user", content: `hello from ${id}` }, { role: "assistant", content: "reply" }],
            createdAt: stale,
            updatedAt: stale,
          };
        }),
      },
    } as unknown as ServerContext;
    const url = new URL("http://test/api/sessions/auto-summarize");
    const cap = mockResponse();

    const handled = await handleSessionRoutes("POST", url, mockJsonRequest({}), cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body) as { ok: boolean; summarized: number; total: number };
    expect(body.summarized).toBe(1);
    expect(body.total).toBe(1); // synthetic sessions don't even count as stale work
    expect(loaded).toEqual(["chat-old"]);
    expect(readdirSync(join(dataDir, "memory", "session-summaries"))).toEqual(["chat-old.md"]);
  });
});
