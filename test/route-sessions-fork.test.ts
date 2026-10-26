/**
 * POST /api/sessions/fork — a fork copies the transcript up to a message; with
 * mode "code" it is a code session in the source's project folder, which is
 * how a chat continues as coding work (a session's mode is fixed at creation,
 * src/session/mode.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { handleSessionRoutes } from "../src/routes/sessions.js";
import type { ServerContext } from "../src/server-context.js";
import type { Session } from "../src/types.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

function makeCtx(source: Session) {
  const saved: Session[] = [];
  const ctx = {
    flushSession: vi.fn(async () => {}),
    getOrCreateSession: vi.fn(() => source),
    saveSession: vi.fn((s: Session) => { saved.push(s); }),
  } as unknown as ServerContext;
  return { ctx, saved };
}

const source: Session = {
  id: "chat-abc123", title: "recipes", projectId: "proj-1",
  messages: [
    { role: "user", content: "build the recipe library" },
    { role: "assistant", content: "on it" },
    { role: "user", content: "now the seed script" },
  ],
  createdAt: 1, updatedAt: 2,
};

async function fork(body: Record<string, unknown>) {
  const { ctx, saved } = makeCtx(source);
  const cap = mockResponse();
  const handled = await handleSessionRoutes("POST", new URL("http://test/api/sessions/fork"), mockJsonRequest(body), cap.res, ctx, "user");
  expect(handled).toBe(true);
  return { status: cap.status, body: JSON.parse(cap.body), saved };
}

describe("POST /api/sessions/fork", () => {
  it("a plain fork stays a chat, carrying the project", async () => {
    const { status, body, saved } = await fork({ sessionId: source.id, atIndex: 2 });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("chat");
    expect(saved).toHaveLength(1);
    expect(saved[0].mode).toBeUndefined();
    expect(saved[0].projectId).toBe("proj-1");
    expect(saved[0].title).toBe("Fork: recipes");
    expect(saved[0].messages).toHaveLength(3);
    expect(saved[0].forkedFrom).toBe(source.id);
  });

  it("mode \"code\" makes the fork a code session in the source's project", async () => {
    const { body, saved } = await fork({ sessionId: source.id, atIndex: 2, mode: "code" });
    expect(body.mode).toBe("code");
    expect(body.projectId).toBe("proj-1");
    expect(saved[0].mode).toBe("code");
    expect(saved[0].projectId).toBe("proj-1");
    expect(saved[0].title).toBe("Code: recipes");
    expect(saved[0].messages).toEqual(source.messages);
  });

  it("an unknown mode is ignored, not stored", async () => {
    const { saved } = await fork({ sessionId: source.id, atIndex: 1, mode: "turbo" });
    expect(saved[0].mode).toBeUndefined();
    expect(saved[0].messages).toHaveLength(2);
  });
});
