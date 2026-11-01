/**
 * GET /api/sessions/:id/messages and /export read the conversation the
 * SessionStore keeps (sessions/<id>.jsonl). Both used to look for `<id>.json`
 * files no store writes any more, so both answered 404 for every session, and
 * "Continue in Code mode" opened its fork with no messages.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import { SessionStore } from "../src/memory/session-store.js";
import type { ServerContext } from "../src/server-context.js";
import type { Session } from "../src/types.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function storeWith(session: Session) {
  const dir = mkdtempSync(join(tmpdir(), "lax-sessions-"));
  dirs.push(dir);
  const sessionStore = new SessionStore(dir);
  sessionStore.save(session);
  const ctx = { sessionStore, flushSession: vi.fn(async () => {}) } as unknown as ServerContext;
  return ctx;
}

const session: Session = {
  id: "chat-fork-1", title: "Code: recipes",
  messages: [
    { role: "user", content: "build the recipe library" },
    { role: "assistant", content: "on it" },
  ],
  createdAt: 1, updatedAt: 2,
};

async function get(ctx: ServerContext, path: string) {
  const cap = mockResponse();
  await handleSessionRoutes("GET", new URL(`http://test${path}`), mockJsonRequest({}), cap.res, ctx, "user");
  return { status: cap.status, body: JSON.parse(cap.body) };
}

describe("session messages and export read the stored conversation", () => {
  it("pages the messages, after the session's pending write lands", async () => {
    const ctx = storeWith(session);
    const r = await get(ctx, "/api/sessions/chat-fork-1/messages");
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { content: string }) => m.content)).toEqual(["build the recipe library", "on it"]);
    expect(ctx.flushSession).toHaveBeenCalledWith("chat-fork-1");
  });

  it("exports the conversation", async () => {
    const r = await get(storeWith(session), "/api/sessions/chat-fork-1/export?format=markdown");
    expect(r.status).toBe(200);
    expect(r.body).toContain("build the recipe library");
  });

  it("answers 404 for a session that does not exist", async () => {
    const ctx = storeWith(session);
    expect((await get(ctx, "/api/sessions/chat-missing/messages")).status).toBe(404);
    expect((await get(ctx, "/api/sessions/chat-missing/export")).status).toBe(404);
  });
});
