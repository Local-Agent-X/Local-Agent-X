import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ServerEvent } from "../src/types.js";

// Mocks for the three modules tryWorkerRedirect imports dynamically.
const activeOpsBySession = new Map<string, string[]>();
const tasksByOpId = new Map<string, string>();
const redirectedCalls: Array<{ opId: string; instruction: string }> = [];
let redirectOpReturn = true;
type ClassifyResult = { redirect: boolean; reason: string } | null;
let classifierResult: ClassifyResult = { redirect: true, reason: "feedback for worker" };

vi.mock("../src/workers/session-bridge.js", () => ({
  listOpsForSession: vi.fn((sessionId: string) => activeOpsBySession.get(sessionId) ?? []),
  getOpTask: vi.fn((opId: string) => tasksByOpId.get(opId) ?? "(unknown)"),
}));

vi.mock("../src/canonical-loop/index.js", () => ({
  opRedirect: vi.fn((opId: string, instruction: string) => {
    redirectedCalls.push({ opId, instruction });
    return { ok: redirectOpReturn };
  }),
}));

vi.mock("../src/routing/worker-redirect-classifier.js", () => ({
  classifyWorkerRedirect: vi.fn(async () => classifierResult),
}));

import { tryWorkerRedirect } from "../src/routes/chat/jarvis-redirect.js";

function captureSink(): { events: ServerEvent[]; sink: (e: ServerEvent) => void } {
  const events: ServerEvent[] = [];
  return { events, sink: (e: ServerEvent) => { events.push(e); } };
}

beforeEach(() => {
  activeOpsBySession.clear();
  tasksByOpId.clear();
  redirectedCalls.length = 0;
  redirectOpReturn = true;
  classifierResult = { redirect: true, reason: "feedback for worker" };
  vi.clearAllMocks();
});

describe("tryWorkerRedirect — no active workers", () => {
  it("returns false when there are no active ops for the session", async () => {
    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "make it blue",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("tryWorkerRedirect — classifier says redirect", () => {
  it("redirects to the most-recently-submitted op and emits two SSE events", async () => {
    activeOpsBySession.set("s1", ["op-old", "op-new"]);
    tasksByOpId.set("op-new", "build a landing page");
    classifierResult = { redirect: true, reason: "feedback" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "make the header blue",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(true);
    // most recent (last) op gets the redirect, not the older one
    expect(redirectedCalls).toEqual([{ opId: "op-new", instruction: "make the header blue" }]);
    // Two SSE events were emitted to the sink: stream + done
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("stream");
    expect((events[0] as { type: "stream"; delta: string }).delta).toContain("telling the worker");
    expect(events[1].type).toBe("done");
  });

  it("falls through (returns false) when redirectOp itself returns false", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    redirectOpReturn = false;
    classifierResult = { redirect: true, reason: "feedback" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });

  it("returns true but emits no events when sseSink is null (WS-only caller)", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    classifierResult = { redirect: true, reason: "feedback" };

    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      sseSink: null,
    });
    expect(result).toBe(true);
    expect(redirectedCalls).toEqual([{ opId: "op-x", instruction: "x" }]);
  });
});

describe("tryWorkerRedirect — classifier says no", () => {
  it("returns false when classifier sets redirect=false", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    classifierResult = { redirect: false, reason: "main agent should answer" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "yes",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(false);
    expect(redirectedCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("returns false when classifier returns null", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    classifierResult = null;

    const { sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(false);
  });
});

describe("tryWorkerRedirect — recentSessionMessages plumbing", () => {
  it("filters down to user/assistant string messages and forwards last 4 turns to classifier", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    classifierResult = { redirect: false, reason: "no" };

    const messages = [
      { role: "system", content: "system prompt" }, // filtered (not user/assistant)
      { role: "tool", content: "tool result" },     // filtered
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];
    const { sink } = captureSink();
    await tryWorkerRedirect({
      sessionId: "s1",
      message: "current",
      recentSessionMessages: messages,
      sseSink: sink,
    });

    const { classifyWorkerRedirect } = await import("../src/routing/worker-redirect-classifier.js");
    const calls = (classifyWorkerRedirect as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [msg, taskHint, recent] = calls[0] as [string, string, Array<{ role: string; content: string }>];
    expect(msg).toBe("current");
    expect(taskHint).toBe("(unknown)");
    // Last 4 user/assistant turns only
    expect(recent.map(t => t.content)).toEqual(["u2", "a2", "u3", "a3"]);
  });
});

describe("tryWorkerRedirect — error handling", () => {
  it("returns false (does not throw) when a downstream import throws", async () => {
    activeOpsBySession.set("s1", ["op-x"]);
    const { classifyWorkerRedirect } = await import("../src/routing/worker-redirect-classifier.js");
    (classifyWorkerRedirect as unknown as { mockImplementationOnce: (fn: () => Promise<never>) => void })
      .mockImplementationOnce(() => Promise.reject(new Error("classifier blew up")));

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      sseSink: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });
});
