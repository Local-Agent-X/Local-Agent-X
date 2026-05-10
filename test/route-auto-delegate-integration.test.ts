import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

// Stub the dynamic-imported modules. The auto-delegate route does
// `await import("../../routing/index.js")` etc., so vi.mock needs the
// path that resolves at runtime — i.e. relative to src/routes/chat/.
// We mock the source modules; the runtime .js extension still resolves to
// these mocked versions via Vite's module graph.
const recentDecisions: unknown[] = [];
const overrideResults = new Map<string, { message: string }>();
const killedOps = new Set<string>();

vi.mock("../src/routing/index.js", () => ({
  getRecentAutoDelegateDecisions: vi.fn((limit: number) => recentDecisions.slice(0, limit)),
  markDecisionAsUserOverride: vi.fn((opId: string) => overrideResults.get(opId) ?? { message: "(none)" }),
}));

vi.mock("../src/workers/pool.js", () => ({
  killOp: vi.fn((opId: string) => killedOps.has(opId)),
}));

import { handleAutoDelegateRoutes } from "../src/routes/chat/auto-delegate-routes.js";

beforeEach(() => {
  recentDecisions.length = 0;
  overrideResults.clear();
  killedOps.clear();
  vi.clearAllMocks();
});

describe("handleAutoDelegateRoutes — dispatch", () => {
  it("returns false when path does not match any auto-delegate route", async () => {
    const url = new URL("http://test/api/something-else");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    expect(await handleAutoDelegateRoutes("GET", url, req, cap.res)).toBe(false);
  });
});

describe("GET /api/auto-delegate/recent", () => {
  it("returns the recent decisions list", async () => {
    recentDecisions.push({ ts: 1, delegate: true }, { ts: 2, delegate: false });
    const url = new URL("http://test/api/auto-delegate/recent?limit=10");
    const req = mockJsonRequest({});
    (req as unknown as { method: string }).method = "GET";
    const cap = mockResponse();
    const handled = await handleAutoDelegateRoutes("GET", url, req, cap.res);
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.decisions).toHaveLength(2);
  });

  it("respects the limit query param (default 50)", async () => {
    for (let i = 0; i < 100; i++) recentDecisions.push({ ts: i, delegate: true });
    const url = new URL("http://test/api/auto-delegate/recent?limit=5");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    await handleAutoDelegateRoutes("GET", url, req, cap.res);
    expect(JSON.parse(cap.body).decisions).toHaveLength(5);
  });
});

describe("POST /api/op/kill", () => {
  it("returns ok=true when killOp succeeds", async () => {
    killedOps.add("op-123");
    const url = new URL("http://test/api/op/kill");
    const req = mockJsonRequest({ op_id: "op-123" });
    const cap = mockResponse();
    const handled = await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expect(JSON.parse(cap.body)).toEqual({ ok: true });
  });

  it("returns ok=false when killOp returns false (op not found)", async () => {
    const url = new URL("http://test/api/op/kill");
    const req = mockJsonRequest({ op_id: "missing-op" });
    const cap = mockResponse();
    await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(JSON.parse(cap.body)).toEqual({ ok: false });
  });

  it("rejects missing op_id with 400", async () => {
    const url = new URL("http://test/api/op/kill");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    const handled = await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(handled).toBe(true);
    expect(cap.status).toBe(400);
    expect(JSON.parse(cap.body).error).toMatch(/op_id required/);
  });

  it("rejects non-string op_id with 400", async () => {
    const url = new URL("http://test/api/op/kill");
    const req = mockJsonRequest({ op_id: 123 });
    const cap = mockResponse();
    await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(cap.status).toBe(400);
  });
});

describe("POST /api/auto-delegate/override", () => {
  it("returns the override decision message + killed flag", async () => {
    overrideResults.set("op-x", { message: "Original user message here" });
    killedOps.add("op-x");
    const url = new URL("http://test/api/auto-delegate/override");
    const req = mockJsonRequest({ opId: "op-x" });
    const cap = mockResponse();
    const handled = await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    const body = JSON.parse(cap.body);
    expect(body.ok).toBe(true);
    expect(body.opId).toBe("op-x");
    expect(body.killed).toBe(true);
    expect(body.message).toBe("Original user message here");
    expect(body.hint).toMatch(/discuss/);
  });

  it("rejects missing opId with 400", async () => {
    const url = new URL("http://test/api/auto-delegate/override");
    const req = mockJsonRequest({});
    const cap = mockResponse();
    await handleAutoDelegateRoutes("POST", url, req, cap.res);
    expect(cap.status).toBe(400);
    expect(JSON.parse(cap.body).error).toMatch(/opId required/);
  });
});
