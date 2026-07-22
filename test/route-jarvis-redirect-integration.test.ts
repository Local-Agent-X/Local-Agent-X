import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ServerEvent } from "../src/types.js";

// Mocks for the four modules tryWorkerRedirect imports dynamically.
const activeOpsBySession = new Map<string, string[]>();
const tasksByOpId = new Map<string, string>();
const opsById = new Map<string, { id: string; status: string; type: string }>();
const redirectedCalls: Array<{ opId: string; instruction: string }> = [];
let redirectOpReturn = true;
type ClassifyResult = { redirect: boolean; reason: string } | null;
let classifierResult: ClassifyResult = { redirect: true, reason: "feedback for worker" };

vi.mock("../src/ops/session-bridge.js", () => ({
  listOpsForSession: vi.fn((sessionId: string) => activeOpsBySession.get(sessionId) ?? []),
  getOpTask: vi.fn((opId: string) => tasksByOpId.get(opId) ?? "(unknown)"),
}));

vi.mock("../src/ops/op-store.js", () => ({
  readOp: vi.fn((opId: string) => opsById.get(opId) ?? null),
  isInteractiveHostOpType: vi.fn((type: string) => type === "chat_turn" || type === "voice_turn"),
}));

/** Track an op for a session with a live-worker default shape. */
function trackOp(sessionId: string, opId: string, status = "running", type = "task"): void {
  const ids = activeOpsBySession.get(sessionId) ?? [];
  ids.push(opId);
  activeOpsBySession.set(sessionId, ids);
  opsById.set(opId, { id: opId, status, type });
}

vi.mock("../src/canonical-loop/index.js", () => ({
  opRedirect: vi.fn((opId: string, instruction: string) => {
    redirectedCalls.push({ opId, instruction });
    return { ok: redirectOpReturn };
  }),
  opRedirectOnce: vi.fn((opId: string, instruction: string) => {
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
  opsById.clear();
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
      emit: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("tryWorkerRedirect — classifier says redirect", () => {
  it("redirects to the most-recently-submitted op and emits two SSE events", async () => {
    trackOp("s1", "op-old");
    trackOp("s1", "op-new");
    tasksByOpId.set("op-new", "build a landing page");
    classifierResult = { redirect: true, reason: "feedback" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "make the header blue",
      recentSessionMessages: [],
      emit: sink,
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
    trackOp("s1", "op-x");
    redirectOpReturn = false;
    classifierResult = { redirect: true, reason: "feedback" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });

  it("emits the ack and done through the provided emit on every transport", async () => {
    trackOp("s1", "op-x");
    classifierResult = { redirect: true, reason: "feedback" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(true);
    expect(redirectedCalls).toEqual([{ opId: "op-x", instruction: "x" }]);
    // The WS-transport fix (322273c5): the ack + done fire on whatever emit
    // the caller wires (WS or SSE), never skipped.
    expect(events).toHaveLength(2);
  });
});

describe("tryWorkerRedirect — live-worker targeting (OP-7)", () => {
  it("skips a still-streaming chat_turn and redirects to the live worker instead", async () => {
    trackOp("s1", "op-worker");
    // The interactive host turn is the NEWEST tracked op — it must never be
    // the redirect target, or the user's message dies with the turn.
    trackOp("s1", "op-chat-turn", "running", "chat_turn");

    const { sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "make the header blue",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(true);
    expect(redirectedCalls).toEqual([{ opId: "op-worker", instruction: "make the header blue" }]);
  });

  it("returns false without classifying when the only tracked ops are host turns", async () => {
    trackOp("s1", "op-chat-turn", "running", "chat_turn");
    trackOp("s1", "op-voice-turn", "running", "voice_turn");

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "make the header blue",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(false);
    expect(redirectedCalls).toEqual([]);
    expect(events).toEqual([]);
    const { classifyWorkerRedirect } = await import("../src/routing/worker-redirect-classifier.js");
    expect(classifyWorkerRedirect).not.toHaveBeenCalled();
  });

  it("skips non-live ops (cancelling/terminal/unknown) and targets the newest live worker", async () => {
    trackOp("s1", "op-live");
    trackOp("s1", "op-cancelling", "cancelling");
    trackOp("s1", "op-done", "done");
    // Tracked in the session map but missing from the op store entirely.
    activeOpsBySession.get("s1")!.push("op-ghost");

    const { sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(true);
    expect(redirectedCalls).toEqual([{ opId: "op-live", instruction: "x" }]);
  });

  it("still targets a pending (not-yet-running) worker", async () => {
    trackOp("s1", "op-pending", "pending");

    const { sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(true);
    expect(redirectedCalls).toEqual([{ opId: "op-pending", instruction: "x" }]);
  });
});

describe("tryWorkerRedirect — classifier says no", () => {
  it("returns false when classifier sets redirect=false", async () => {
    trackOp("s1", "op-x");
    classifierResult = { redirect: false, reason: "main agent should answer" };

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "yes",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(false);
    expect(redirectedCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("returns false when classifier returns null", async () => {
    trackOp("s1", "op-x");
    classifierResult = null;

    const { sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(false);
  });
});

describe("tryWorkerRedirect — recentSessionMessages plumbing", () => {
  it("filters down to user/assistant string messages and forwards last 4 turns to classifier", async () => {
    trackOp("s1", "op-x");
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
      emit: sink,
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
    trackOp("s1", "op-x");
    const { classifyWorkerRedirect } = await import("../src/routing/worker-redirect-classifier.js");
    (classifyWorkerRedirect as unknown as { mockImplementationOnce: (fn: () => Promise<never>) => void })
      .mockImplementationOnce(() => Promise.reject(new Error("classifier blew up")));

    const { events, sink } = captureSink();
    const result = await tryWorkerRedirect({
      sessionId: "s1",
      message: "x",
      recentSessionMessages: [],
      emit: sink,
    });
    expect(result).toBe(false);
    expect(events).toEqual([]);
  });
});
