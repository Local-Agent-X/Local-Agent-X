import { describe, it, expect, vi } from "vitest";
import { handleCompactRoute } from "../src/routes/chat/compact-route.js";
import type { ServerContext } from "../src/server-context.js";
import type { Session } from "../src/types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

// Build a session with N user/assistant alternations
function buildSession(id: string, turns: number): Session {
  const messages: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `user message ${i + 1}` });
    messages.push({ role: "assistant", content: `assistant reply ${i + 1}` });
  }
  return {
    id, title: "test", messages,
    createdAt: Date.now() - 1_000_000,
    updatedAt: Date.now() - 1_000_000,
  };
}

interface MockCtx {
  session: Session;
  saveCalls: number;
  ctx: ServerContext;
}

function makeMockCtx(session: Session): MockCtx {
  const m: MockCtx = { session, saveCalls: 0, ctx: null as unknown as ServerContext };
  m.ctx = {
    getOrCreateSession: vi.fn((_id: string) => session),
    flushSession: vi.fn(async (_id: string) => {}),
    sessionStore: {
      save: vi.fn(() => { m.saveCalls++; }),
    },
  } as unknown as ServerContext;
  return m;
}

describe("handleCompactRoute — dispatch", () => {
  it("returns false when method is not POST", async () => {
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    const m = makeMockCtx(buildSession("s1", 20));
    const handled = await handleCompactRoute("GET", url, req, cap.res, m.ctx);
    expect(handled).toBe(false);
  });

  it("returns false on a different path", async () => {
    const url = new URL("http://test/api/other");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    const m = makeMockCtx(buildSession("s1", 20));
    const handled = await handleCompactRoute("POST", url, req, cap.res, m.ctx);
    expect(handled).toBe(false);
  });
});

describe("handleCompactRoute — validation", () => {
  it("rejects malformed sessionId with 400", async () => {
    const url = new URL("http://test/api/compact");
    // sessionId pattern is ^[a-zA-Z0-9_-]{1,64}$ — slashes break it
    const req = mockJsonRequest({ sessionId: "bad/id" });
    const cap = mockResponse();
    const m = makeMockCtx(buildSession("s1", 20));
    const handled = await handleCompactRoute("POST", url, req, cap.res, m.ctx);
    expect(handled).toBe(true);
    expect(cap.status).toBe(400);
    expect(JSON.parse(cap.body).error).toBeDefined();
  });

  it("defaults sessionId to 'default' when omitted (per CompactSchema)", async () => {
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    const m = makeMockCtx(buildSession("default", 3));
    const handled = await handleCompactRoute("POST", url, req, cap.res, m.ctx);
    expect(handled).toBe(true);
    // 3 turns = 6 messages, under the 10-msg threshold → ok=false (not 400)
    expect(cap.status).toBe(200);
    expect(JSON.parse(cap.body).ok).toBe(false);
  });
});

describe("handleCompactRoute — short sessions are not compacted", () => {
  it("returns ok=false when session has fewer than 10 messages", async () => {
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({ sessionId: "s1" });
    const cap = mockResponse();
    const m = makeMockCtx(buildSession("s1", 3)); // 6 messages total
    const handled = await handleCompactRoute("POST", url, req, cap.res, m.ctx);
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/need 10/);
    // Did NOT save the session
    expect(m.saveCalls).toBe(0);
  });
});

describe("handleCompactRoute — long sessions are compacted", () => {
  it("replaces older messages with a single system summary entry", async () => {
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({ sessionId: "s1" });
    const cap = mockResponse();
    const session = buildSession("s1", 20); // 40 messages
    const m = makeMockCtx(session);

    const handled = await handleCompactRoute("POST", url, req, cap.res, m.ctx);
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.ok).toBe(true);
    expect(body.oldCount).toBeGreaterThan(0);
    expect(body.recentCount).toBeLessThanOrEqual(20);

    // First message is now the compaction summary
    expect(session.messages[0].role).toBe("system");
    expect(typeof session.messages[0].content).toBe("string");
    expect(session.messages[0].content as string).toContain("COMPACTED CONTEXT");

    // Total length is now 1 (summary) + recent count
    expect(session.messages.length).toBe(1 + body.recentCount);

    // Saved exactly once
    expect(m.saveCalls).toBe(1);
  });

  it("compaction summary contains line entries for older user/assistant messages", async () => {
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({ sessionId: "s1" });
    const cap = mockResponse();
    const session = buildSession("s1", 25);
    const m = makeMockCtx(session);

    await handleCompactRoute("POST", url, req, cap.res, m.ctx);

    const summary = session.messages[0].content as string;
    expect(summary).toContain("[User]");
    expect(summary).toContain("[Agent]");
    expect(summary).toMatch(/\[END COMPACTED CONTEXT/);
  });

  it("anchors the cut to the next user message so the recent slice begins on a turn boundary", async () => {
    // Build a session whose KEEP_RECENT slice falls in the middle of an
    // assistant message; the route should advance the cut to the next user.
    const messages: ChatCompletionMessageParam[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `u${i}` });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    const session: Session = {
      id: "s1", title: "t", messages,
      createdAt: 1, updatedAt: 1,
    };
    const url = new URL("http://test/api/compact");
    const req = mockJsonRequest({ sessionId: "s1" });
    const cap = mockResponse();
    const m = makeMockCtx(session);

    await handleCompactRoute("POST", url, req, cap.res, m.ctx);

    // After compaction, messages[0] is summary, messages[1] should be a "user" role
    // (the first message of the recent window) — the anchor invariant.
    expect(session.messages[0].role).toBe("system");
    expect(session.messages[1].role).toBe("user");
  });
});
