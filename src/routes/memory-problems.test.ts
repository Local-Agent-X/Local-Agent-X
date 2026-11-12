import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { ServerContext } from "../server-context.js";
import type { ToolFailureEvent } from "../tool-execution/tool-usage-telemetry.js";
import type { CapabilityGap } from "../cognition/cross-session-learning/capability-gaps.js";

let failures: ToolFailureEvent[] = [];
let gaps: CapabilityGap[] = [];
let readSince = 0;

vi.mock("../tool-execution/tool-usage-telemetry.js", () => ({
  readToolFailures: async (sinceMs: number) => { readSince = sinceMs; return failures; },
}));
vi.mock("../cognition/cross-session-learning/capability-gaps.js", () => ({
  readCapabilityGaps: () => gaps,
}));

const { handleMemoryProblemRoutes } = await import("./memory-problems.js");

const DAY = 24 * 60 * 60 * 1000;

function fail(sessionId: string, agoMs: number): ToolFailureEvent {
  return {
    at: Date.now() - agoMs, tool: "bash", status: "error", sessionId,
    failure: { signature: "sig-python", reason: "python3: command not found", opId: `op-${sessionId}`, toolCallId: "c1" },
  };
}

async function call(method: string, path: string) {
  const req = Readable.from([]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, setHeader() {}, end(b?: string) { if (b) res.body = b; return res; } };
  const handled = await handleMemoryProblemRoutes(method, new URL(`http://x${path}`), req as never, res as never, {} as ServerContext, "readonly");
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => { failures = []; gaps = []; readSince = 0; });

describe("/api/memory/problems", () => {
  it("lists a failure that keeps happening, with its counts and without run ids", async () => {
    failures = [fail("s1", 2 * DAY), fail("s2", DAY), fail("s3", 60_000)];
    const { status, body } = await call("GET", "/api/memory/problems");
    expect(status).toBe(200);
    expect(body.windowDays).toBe(14);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]).toMatchObject({
      signature: "sig-python", tool: "bash", action: null, status: "error", layer: null,
      reason: "python3: command not found", count: 3, sessions: 3,
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
