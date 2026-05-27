import { describe, it, expect, vi } from "vitest";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

// Sessions of every prefix family that exists in the codebase. The two
// groups that bulk-DELETE must preserve are system internals
// (dream/cron/ide) and integration threads (wa/tg/sms). Everything else
// (chat, fork, agent, mobile, untyped) is fair game.
const ALL_SESSIONS = [
  { id: "chat-aaa", title: "regular", updatedAt: 1, messageCount: 2 },
  { id: "chat-bbb", title: "regular", updatedAt: 1, messageCount: 2 },
  { id: "fork-ccc", title: "fork", updatedAt: 1, messageCount: 2 },
  { id: "mobile-ddd", title: "mobile", updatedAt: 1, messageCount: 2 },
  { id: "agent-eee", title: "agent", updatedAt: 1, messageCount: 2 },
  { id: "untyped", title: "untyped", updatedAt: 1, messageCount: 2 },
  // Preserved — system internals
  { id: "dream-fff", title: "dream", updatedAt: 1, messageCount: 2 },
  { id: "cron-ggg", title: "cron", updatedAt: 1, messageCount: 2 },
  { id: "ide-hhh", title: "ide", updatedAt: 1, messageCount: 2 },
  // Preserved — integration bridges
  { id: "wa-111", title: "whatsapp", updatedAt: 1, messageCount: 2 },
  { id: "tg-222", title: "telegram", updatedAt: 1, messageCount: 2 },
  { id: "sms-333", title: "sms", updatedAt: 1, messageCount: 2 },
];

const PROTECTED_IDS = new Set([
  "dream-fff", "cron-ggg", "ide-hhh",
  "wa-111", "tg-222", "sms-333",
]);
const DELETABLE_IDS = new Set([
  "chat-aaa", "chat-bbb", "fork-ccc", "mobile-ddd", "agent-eee", "untyped",
]);

function makeCtx() {
  const deleted: string[] = [];
  const ctx = {
    sessionStore: {
      list: vi.fn(() => ALL_SESSIONS.slice()),
      delete: vi.fn((id: string) => { deleted.push(id); }),
    },
  } as unknown as ServerContext;
  return { ctx, deleted };
}

describe("DELETE /api/sessions — bulk delete", () => {
  it("preserves system internals (dream/cron/ide) and integration threads (wa/tg/sms)", async () => {
    const { ctx, deleted } = makeCtx();
    const url = new URL("http://test/api/sessions");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleSessionRoutes("DELETE", url, req, cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(DELETABLE_IDS.size);
    expect(body.skipped).toBe(PROTECTED_IDS.size);

    // Nothing protected was touched
    for (const id of deleted) {
      expect(PROTECTED_IDS.has(id)).toBe(false);
    }
    // Everything deletable was touched
    expect(new Set(deleted)).toEqual(DELETABLE_IDS);
  });

  it("returns deleted=0 skipped>0 when every session is protected", async () => {
    const deleted: string[] = [];
    const ctx = {
      sessionStore: {
        list: vi.fn(() => ALL_SESSIONS.filter(s => PROTECTED_IDS.has(s.id))),
        delete: vi.fn((id: string) => { deleted.push(id); }),
      },
    } as unknown as ServerContext;
    const url = new URL("http://test/api/sessions");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    await handleSessionRoutes("DELETE", url, req, cap.res, ctx, "user");

    const body = JSON.parse(cap.body);
    expect(body.deleted).toBe(0);
    expect(body.skipped).toBe(PROTECTED_IDS.size);
    expect(deleted).toEqual([]);
  });
});

describe("DELETE /api/sessions/<id> — per-session delete", () => {
  it("still removes a protected session when targeted explicitly", async () => {
    const { ctx, deleted } = makeCtx();
    const url = new URL("http://test/api/sessions/wa-111");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleSessionRoutes("DELETE", url, req, cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expect(deleted).toEqual(["wa-111"]);
  });
});
