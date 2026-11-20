// Deleting chats through /api/sessions (src/session/remove.ts): Delete keeps
// the transcript and takes the chat out of every list; Erase removes it for
// good and leaves a sync tombstone; Fresh starts a reused id over.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { repointFile } = vi.hoisted(() => ({ repointFile: vi.fn(() => true) }));
vi.mock("../src/memory/index-sync.js", async (orig) => ({ ...(await orig<object>()), repointFile }));

import { handleSessionRoutes } from "../src/routes/sessions.js";
import { SessionStore } from "../src/memory/session-store.js";
import type { ServerContext } from "../src/server-context.js";
import type { Session } from "../src/types.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import { randomId } from "../src/util/ids.js";

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "lax-session-delete-")); repointFile.mockClear(); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function chat(id: string, extra: Partial<Session> = {}): Session {
  return { id, title: id, messages: [{ role: "user", content: `hello from ${id}` }], createdAt: 1, updatedAt: 1, ...extra };
}

function makeCtx(seed: Session[]) {
  const sessionStore = new SessionStore(dataDir);
  for (const s of seed) sessionStore.save(s);
  const cache = new Map<string, Session>();
  const forgotten: string[] = [];
  const frames: Array<{ type: string }> = [];
  const active: string[] = [];
  const ctx = {
    dataDir, sessionStore,
    memoryIndex: { forgetChunksAtPath: (p: string) => { forgotten.push(p); return 1; }, maintenanceDb: () => ({}) },
    getOrCreateSession: (id: string) => {
      let s = cache.get(id) ?? sessionStore.load(id) ?? { id, title: "New Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      cache.set(id, s);
      return s;
    },
    saveSession: async (s: Session) => { cache.set(s.id, s); sessionStore.save(s); },
    flushSession: async () => {},
    dropSession: (id: string) => { cache.delete(id); },
    chatWs: { getActiveChats: () => active },
    broadcastAll: (f: { type: string }) => { frames.push(f); return 0; },
  } as unknown as ServerContext;
  return { ctx, sessionStore, cache, forgotten, frames, active };
}

async function call(ctx: ServerContext, method: string, path: string, role: "user" | "agent" = "user") {
  const cap = mockResponse();
  const handled = await handleSessionRoutes(method, new URL(`http://test${path}`), mockJsonRequest({}), cap.res, ctx, role);
  expect(handled).toBe(true);
  return { status: cap.status, body: JSON.parse(cap.body) };
}

const listedIds = async (ctx: ServerContext) => ((await call(ctx, "GET", "/api/sessions")).body as Array<{ id: string }>).map((s) => s.id);
const log = (id: string) => join(dataDir, "sessions", `${id}.jsonl`);

describe("GET /api/sessions — what the chat lists show", () => {
  // App IDE sessions (ide-) are listed: they are code sessions, which the
  // sidebar's Code side shows under their app (src/session/mode.ts).
  it("hides internal sessions and deleted chats, keeps regular, bridge and App IDE sessions", async () => {
    const { ctx } = makeCtx([
      chat("chat-aaa"), chat("wa-111"), chat("dream-fff"), chat("cron-ggg"), chat("ide-hhh"),
      chat("skill-review-iii"), chat(randomId("eval")), chat("chat-gone", { removedAt: 5, updatedAt: 5 }),
    ]);
    expect((await listedIds(ctx)).sort()).toEqual(["chat-aaa", "ide-hhh", "wa-111"]);
  });
});

describe("DELETE /api/sessions/<id> — Delete keeps the chat", () => {
  it("takes it out of the list and leaves its transcript on disk, readable", async () => {
    const { ctx, sessionStore, frames } = makeCtx([chat("chat-aaa"), chat("chat-bbb")]);
    const { status, body } = await call(ctx, "DELETE", "/api/sessions/chat-aaa");

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, removed: true });
    expect(await listedIds(ctx)).toEqual(["chat-bbb"]);
    expect(existsSync(log("chat-aaa"))).toBe(true);
    expect(sessionStore.load("chat-aaa")?.messages).toHaveLength(1);
    expect(frames.map((f) => f.type)).toContain("chat_list_changed");
  });

  it("stays out of the list after the store reloads from disk", async () => {
    const { ctx } = makeCtx([chat("chat-aaa")]);
    await call(ctx, "DELETE", "/api/sessions/chat-aaa");
    rmSync(join(dataDir, "sessions", ".metadata.json"), { force: true });
    rmSync(join(dataDir, "sessions", ".metadata.jsonl"), { force: true });
    expect(new SessionStore(dataDir).list().find((m) => m.id === "chat-aaa")?.removedAt).toBeGreaterThan(0);
  });

  it("comes back when something newer is saved in it (a WhatsApp thread's next message)", async () => {
    const { ctx } = makeCtx([chat("wa-111")]);
    await call(ctx, "DELETE", "/api/sessions/wa-111");
    expect(await listedIds(ctx)).toEqual([]);

    const s = ctx.getOrCreateSession("wa-111");
    s.messages.push({ role: "user", content: "another message" });
    s.updatedAt = Date.now() + 1000;
    await ctx.saveSession(s);
    expect(await listedIds(ctx)).toEqual(["wa-111"]);
  });

  it("answers removed:false for a chat that was never saved", async () => {
    const { ctx } = makeCtx([]);
    expect((await call(ctx, "DELETE", "/api/sessions/chat-new")).body).toEqual({ ok: true, removed: false });
  });
});

describe("DELETE /api/sessions — Delete all", () => {
  it("removes every chat in Conversations, keeps projects, code sessions, messaging threads and ?keep", async () => {
    const { ctx } = makeCtx([
      chat("chat-aaa"), chat("chat-bbb"), chat("chat-mine"), chat("wa-111"), chat("tg-222"),
      chat("chat-proj", { projectId: "p1" }), chat("chat-code", { mode: "code" }),
    ]);
    const { body } = await call(ctx, "DELETE", "/api/sessions?keep=chat-mine");

    expect(body).toEqual({ ok: true, removed: 2 });
    expect((await listedIds(ctx)).sort()).toEqual(["chat-code", "chat-mine", "chat-proj", "tg-222", "wa-111"]);
    expect(existsSync(log("chat-aaa")) && existsSync(log("chat-bbb"))).toBe(true);
  });
});

describe("POST /api/sessions/<id>/erase — Erase removes it for good", () => {
  it("removes every copy, its search entries and summary, and leaves a sync tombstone", async () => {
    const { ctx, forgotten, cache } = makeCtx([chat("chat-aaa")]);
    ctx.getOrCreateSession("chat-aaa");
    mkdirSync(join(dataDir, "sessions-archive"), { recursive: true });
    writeFileSync(join(dataDir, "sessions-archive", "chat-aaa.1700000000000.jsonl"), "{}\n");
    mkdirSync(join(dataDir, "memory", "session-summaries"), { recursive: true });
    writeFileSync(join(dataDir, "memory", "session-summaries", "chat-aaa.md"), "# chat-aaa\n");
    mkdirSync(join(dataDir, "sync-repo", "sessions"), { recursive: true });
    writeFileSync(join(dataDir, "sync-repo", "sessions", "chat-aaa.jsonl"), "{}\n");

    const { status, body } = await call(ctx, "POST", "/api/sessions/chat-aaa/erase");

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, erased: true });
    expect(existsSync(log("chat-aaa"))).toBe(false);
    expect(readdirSync(join(dataDir, "sessions-archive"))).toEqual([]);
    expect(existsSync(join(dataDir, "memory", "session-summaries", "chat-aaa.md"))).toBe(false);
    expect(forgotten).toEqual(expect.arrayContaining([
      log("chat-aaa"), join(dataDir, "sessions-archive", "chat-aaa.1700000000000.jsonl"),
      join(dataDir, "memory", "session-summaries", "chat-aaa.md"),
    ]));
    expect(cache.has("chat-aaa")).toBe(false);
    expect(existsSync(join(dataDir, "sync-repo", "sessions", "chat-aaa.jsonl"))).toBe(false);
    expect(existsSync(join(dataDir, "sync-repo", ".tombstones", "sessions", "chat-aaa.json"))).toBe(true);
  });

  it("is refused to the agent", async () => {
    const { ctx } = makeCtx([chat("chat-aaa")]);
    expect((await call(ctx, "POST", "/api/sessions/chat-aaa/erase", "agent")).status).toBe(403);
    expect(existsSync(log("chat-aaa"))).toBe(true);
  });

  it("is refused while the chat is still working", async () => {
    const { ctx, active } = makeCtx([chat("chat-aaa")]);
    active.push("chat-aaa");
    expect((await call(ctx, "POST", "/api/sessions/chat-aaa/erase")).status).toBe(409);
    expect(existsSync(log("chat-aaa"))).toBe(true);
  });
});

describe("POST /api/sessions/<id>/fresh — start a reused id over", () => {
  it("archives the old conversation (index re-pointed) and the next open is empty", async () => {
    const { ctx } = makeCtx([chat("ide-app")]);
    ctx.getOrCreateSession("ide-app");

    expect((await call(ctx, "POST", "/api/sessions/ide-app/fresh")).body).toEqual({ ok: true, archived: true });
    expect(existsSync(join(dataDir, "sessions-archive", "ide-app.jsonl"))).toBe(true);
    expect(repointFile).toHaveBeenCalledWith(expect.anything(), log("ide-app"), join(dataDir, "sessions-archive", "ide-app.jsonl"));
    expect(ctx.getOrCreateSession("ide-app").messages).toEqual([]);
  });

  it("a second fresh start keeps both old conversations", async () => {
    const { ctx, sessionStore } = makeCtx([chat("wa-111")]);
    await call(ctx, "POST", "/api/sessions/wa-111/fresh");
    sessionStore.save(chat("wa-111", { createdAt: 2, updatedAt: 2 }));
    await call(ctx, "POST", "/api/sessions/wa-111/fresh");
    expect(readdirSync(join(dataDir, "sessions-archive")).filter((f) => f.startsWith("wa-111")).length).toBe(2);
  });
});
