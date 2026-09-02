import { describe, it, expect, vi } from "vitest";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import { randomId } from "../src/util/ids.js";

// /api/sessions/search used to scan EVERY session on disk — cron-, dream-,
// eval_ and skill-review- transcripts matched user queries and surfaced as
// fake chats in search results (rows the sidebar itself refuses to list).
// Search now hides exactly what the chat lists hide (isHiddenFromChatLists,
// memory/synthetic-sessions.ts). ide- stays searchable: live user chats with
// their own surface. Hidden sessions are filtered BEFORE the slice(0,100)
// scan budget, so their transcripts are never even loaded.

function makeCtx(ids: string[]) {
  const metas = ids.map((id) => ({ id, title: `t-${id}`, updatedAt: 1, messageCount: 1 }));
  const loaded: string[] = [];
  const ctx = {
    sessionStore: {
      list: vi.fn(() => metas.slice()),
      load: vi.fn((id: string) => {
        loaded.push(id);
        return {
          id,
          title: `t-${id}`,
          messages: [{ role: "user", content: `the needle hides in ${id}` }],
          createdAt: 1,
          updatedAt: 1,
        };
      }),
    },
  } as unknown as ServerContext;
  return { ctx, loaded };
}

describe("GET /api/sessions/search — synthetic/scheduled sessions never surface", () => {
  it("returns hits only for user-visible chats; cron-/dream-/eval_/skill-review- stay invisible and unscanned", async () => {
    const evalId = randomId("eval"); // the real minter (routes/chat.ts)
    const cronId = `cron-daily-report-${Date.now()}`; // real minter shape (cron-runner.ts)
    const { ctx, loaded } = makeCtx([
      "chat-aaa",
      "wa-111",
      "tg-222",
      "ide-app1",
      cronId,
      "dream-456",
      "dream-456-b0",
      evalId,
      "skill-review-789",
    ]);
    const url = new URL("http://test/api/sessions/search?q=needle");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleSessionRoutes("GET", url, req, cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body) as { results: Array<{ sessionId: string }> };
    expect(body.results.map((r) => r.sessionId)).toEqual(["chat-aaa", "wa-111", "tg-222", "ide-app1"]);
    // Hidden transcripts must not even be loaded — they'd otherwise burn the
    // slice(0,100) scan budget and crowd out real sessions.
    expect(loaded).toEqual(["chat-aaa", "wa-111", "tg-222", "ide-app1"]);
  });

  it("near-miss ids are NOT hidden (prefix must be leading and exact)", async () => {
    const { ctx } = makeCtx(["my-cron-job", "dreamer", "skill-reviewer"]);
    const url = new URL("http://test/api/sessions/search?q=needle");
    const cap = mockResponse();

    await handleSessionRoutes("GET", url, mockJsonRequest({}), cap.res, ctx, "user");

    const body = JSON.parse(cap.body) as { results: Array<{ sessionId: string }> };
    expect(body.results.map((r) => r.sessionId)).toEqual(["my-cron-job", "dreamer", "skill-reviewer"]);
  });
});
