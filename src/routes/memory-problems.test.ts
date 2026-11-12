import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { ServerContext } from "../server-context.js";
import type { ToolFailureEvent } from "../tool-execution/tool-usage-telemetry.js";
import type { CapabilityGap } from "../cognition/cross-session-learning/capability-gaps.js";
import type { KnownFailure } from "../cognition/cross-session-learning/known-failures.js";
import type { Role } from "../rbac.js";

let failures: ToolFailureEvent[] = [];
let gaps: CapabilityGap[] = [];
let known: KnownFailure[] = [];
let readSince = 0;
const broadcastAll = vi.fn();

vi.mock("../tool-execution/tool-usage-telemetry.js", () => ({
  readToolFailures: async (sinceMs: number) => { readSince = sinceMs; return failures; },
}));
vi.mock("../cognition/cross-session-learning/capability-gaps.js", () => ({
  readCapabilityGaps: () => gaps,
}));
vi.mock("../cognition/cross-session-learning/known-failures.js", () => ({
  listKnownFailures: () => known,
  decideLesson: (signature: string, decision: "keep" | "discard") => {
    const found = known.find((k) => k.signature === signature && k.verdict === "lesson");
    if (!found) return null;
    found.state = decision === "keep" ? "kept" : "discarded";
    return { ...found };
  },
}));

const answered: string[] = [];
vi.mock("../inbox/producers.js", () => ({
  inboxLessonAnswered: (signature: string) => { answered.push(signature); },
}));

const { handleMemoryProblemRoutes } = await import("./memory-problems.js");

const DAY = 24 * 60 * 60 * 1000;
const LESSON = "Use python, not python3, on this computer.";

function fail(sessionId: string, agoMs: number): ToolFailureEvent {
  return {
    at: Date.now() - agoMs, tool: "bash", status: "error", sessionId,
    failure: { signature: "sig-python", reason: "python3: command not found", opId: `op-${sessionId}`, toolCallId: "c1" },
  };
}

function lesson(over: Partial<KnownFailure> = {}): KnownFailure {
  return {
    signature: "abcdef0123456789", tool: "bash", status: "error", reason: "python3: command not found",
    verdict: "lesson", why: "the retry with python worked", lesson: LESSON,
    state: "proposed", sessions: 4, count: 7, reviewedAt: 1, shown: 0, recovered: 0, ...over,
  };
}

async function call(method: string, path: string, body?: unknown, role: Role = "operator") {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, setHeader() {}, end(b?: string) { if (b) res.body = b; return res; } };
  const ctx = { broadcastAll } as unknown as ServerContext;
  const handled = await handleMemoryProblemRoutes(method, new URL(`http://x${path}`), req as never, res as never, ctx, role);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => { failures = []; gaps = []; known = []; readSince = 0; answered.length = 0; broadcastAll.mockReset(); });

describe("/api/memory/problems", () => {
  it("lists a failure that keeps happening, with its counts and without run ids", async () => {
    failures = [fail("s1", 2 * DAY), fail("s2", DAY), fail("s3", 60_000)];
    const { status, body } = await call("GET", "/api/memory/problems", undefined, "readonly");
    expect(status).toBe(200);
    expect(body.windowDays).toBe(14);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatchObject({
      signature: "sig-python", tool: "bash", action: null, status: "error", layer: null,
      reason: "python3: command not found", count: 3, sessions: 3, review: null,
    });
    expect(body.problems[0]).not.toHaveProperty("samples");
    // Only the window is read from the log.
    expect(Date.now() - readSince).toBeGreaterThanOrEqual(14 * DAY);
    expect(Date.now() - readSince).toBeLessThan(14 * DAY + 60_000);
  });

  it("does not list a failure seen in too few chats", async () => {
    failures = [fail("s1", DAY), fail("s2", 60_000)];
    expect((await call("GET", "/api/memory/problems")).body.problems).toEqual([]);
  });

  it("shows what the agent could not do, newest first", async () => {
    gaps = [
      { sessionId: "s1", timestamp: 1, summary: "older", toolsTried: ["memory_search"] },
      { sessionId: "s2", timestamp: 2, summary: "newer", toolsTried: ["grep"], workaround: "read the raw logs" },
    ];
    const { body } = await call("GET", "/api/memory/problems");
    expect(body.gaps).toEqual([
      { at: 2, summary: "newer", toolsTried: ["grep"], workaround: "read the raw logs" },
      { at: 1, summary: "older", toolsTried: ["memory_search"], workaround: null },
    ]);
  });

  it("is read-only and leaves other paths alone", async () => {
    expect((await call("POST", "/api/memory/problems")).status).toBe(405);
    expect((await call("GET", "/api/memory/learning")).handled).toBe(false);
  });
});

describe("lessons", () => {
  it("lists every lesson, newest first, and says what the review made of a problem", async () => {
    failures = [fail("s1", 2 * DAY), fail("s2", DAY), fail("s3", 60_000)];
    known = [
      lesson({ signature: "1111111111111111", state: "kept", shown: 3, recovered: 2 }),
      { ...lesson({ signature: "sig-python" }), verdict: "noise", why: "a site that was down", lesson: undefined, state: undefined },
      lesson(),
    ];
    const { body } = await call("GET", "/api/memory/problems");
    expect(body.lessons.map((l: { signature: string }) => l.signature)).toEqual(["abcdef0123456789", "1111111111111111"]);
    expect(body.lessons[1]).toMatchObject({ state: "kept", shown: 3, recovered: 2, lesson: LESSON });
    expect(body.problems[0].review).toEqual({ verdict: "noise", why: "a site that was down" });
  });

  it("keeps and discards a lesson for the operator, and tells every open tab", async () => {
    known = [lesson()];
    const kept = await call("POST", "/api/memory/problems/abcdef0123456789/action", { action: "keep" });
    expect(kept).toMatchObject({ status: 200, body: { lesson: { state: "kept" } } });
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { recurringProblems: true } });
    // The inbox item that asked is answered.
    expect(answered).toEqual(["abcdef0123456789"]);
    const discarded = await call("POST", "/api/memory/problems/abcdef0123456789/action", { action: "discard" });
    expect(discarded.body.lesson.state).toBe("discarded");
  });

  it("refuses anyone but the operator, a bad id, a bad action, and a problem with no lesson", async () => {
    known = [lesson()];
    expect((await call("POST", "/api/memory/problems/abcdef0123456789/action", { action: "keep" }, "readonly")).status).toBe(403);
    expect((await call("POST", "/api/memory/problems/not-a-signature/action", { action: "keep" })).status).toBe(400);
    expect((await call("POST", "/api/memory/problems/abcdef0123456789/action", { action: "activate" })).status).toBe(400);
    expect((await call("POST", "/api/memory/problems/0000000000000000/action", { action: "keep" })).status).toBe(404);
    expect((await call("GET", "/api/memory/problems/abcdef0123456789/action")).status).toBe(405);
    expect(known[0].state).toBe("proposed");
    expect(broadcastAll).not.toHaveBeenCalled();
    expect(answered).toEqual([]);
  });
});
