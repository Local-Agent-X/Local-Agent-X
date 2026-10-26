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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// A chat that turned into repo work continues in Code mode from the brief the
// agent wrote (code_handoff), on the repo it worked in — not on the whole chat.
describe("POST /api/sessions/fork with a handoff", () => {
  async function forkWithStore(body: Record<string, unknown>) {
    const created: Array<{ name: string; workspace: string }> = [];
    const { ctx, saved } = makeCtx({ ...source, projectId: undefined });
    (ctx as unknown as { projectStore: unknown }).projectStore = {
      list: () => [],
      findByName: () => undefined,
      create: (p: { name: string; workspace: string }) => { created.push(p); return { id: "proj-repo", ...p }; },
    };
    const cap = mockResponse();
    await handleSessionRoutes("POST", new URL("http://test/api/sessions/fork"), mockJsonRequest(body), cap.res, ctx, "user");
    return { status: cap.status, body: JSON.parse(cap.body), saved, created };
  }

  it("opens a code session on the repo's folder, starting from the brief", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lax-handoff-"));
    try {
      mkdirSync(join(repo, "docs", "handoff"), { recursive: true });
      writeFileSync(join(repo, "docs", "handoff", "planner.md"), "# Goal\nWeek grid\n# Left\n1. grocery list");
      const { status, body, saved, created } = await forkWithStore({
        sessionId: source.id, atIndex: 2, mode: "code", handoff: { folder: repo, brief: "docs/handoff/planner.md" },
      });
      expect(status).toBe(200);
      expect(body.projectId).toBe("proj-repo");
      expect(created[0].workspace).toBe(repo);
      expect(saved[0].mode).toBe("code");
      expect(saved[0].projectId).toBe("proj-repo");
      expect(saved[0].messages).toHaveLength(1);
      expect(saved[0].messages[0].role).toBe("system");
      expect(String(saved[0].messages[0].content)).toContain("# Left\n1. grocery list");
      expect(String(saved[0].messages[0].content)).not.toContain("now the seed script");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a brief outside the folder, and a folder that is not there", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lax-handoff-"));
    try {
      const outside = await forkWithStore({ sessionId: source.id, atIndex: 2, mode: "code", handoff: { folder: repo, brief: "../secrets.md" } });
      expect(outside.status).toBe(400);
      const missing = await forkWithStore({ sessionId: source.id, atIndex: 2, mode: "code", handoff: { folder: join(repo, "nope"), brief: "a.md" } });
      expect(missing.status).toBe(400);
      expect(outside.saved).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
