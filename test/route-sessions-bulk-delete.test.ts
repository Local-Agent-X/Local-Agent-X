import { describe, it, expect, vi } from "vitest";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

// A small mixed list — enough to assert "nothing touched" without
// listing every prefix family. The per-session test only needs wa-111.
const ALL_SESSIONS = [
  { id: "chat-aaa", title: "regular", updatedAt: 1, messageCount: 2 },
  { id: "wa-111", title: "whatsapp", updatedAt: 1, messageCount: 2 },
  { id: "tg-222", title: "telegram", updatedAt: 1, messageCount: 2 },
  { id: "dream-fff", title: "dream", updatedAt: 1, messageCount: 2 },
];

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

describe("DELETE /api/sessions — aliased to sidebar_clear", () => {
  it("returns 200 + hidden:true + deleted:0; nothing on disk is touched", async () => {
    const { ctx, deleted } = makeCtx();
    const url = new URL("http://test/api/sessions");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleSessionRoutes("DELETE", url, req, cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.ok).toBe(true);
    expect(body.hidden).toBe(true);
    expect(body.deleted).toBe(0);
    expect(body.note).toMatch(/sidebar_clear/);
    expect(deleted).toEqual([]); // disk untouched regardless of which tool the model picked
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
