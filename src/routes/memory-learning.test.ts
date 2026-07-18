import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({
  mode: "assisted" as "assisted" | "autonomous",
  service: {
    list: vi.fn(),
    detail: vi.fn(),
    action: vi.fn(),
  },
}));

vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ learningMode: mocks.mode, maxRequestBodyBytes: 1_000_000 }),
}));
vi.mock("../cognition/cross-session-learning/service.js", () => ({ default: mocks.service }));

import { handleMemoryLearningRoutes } from "./memory-learning.js";
import type { Role } from "../rbac.js";

const ID = "learned-0123456789abcdefabcd";
const VERSION_1 = "11111111-1111-4111-8111-111111111111";
const VERSION_2 = "22222222-2222-4222-8222-222222222222";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "workflow-coding",
    state: "candidate",
    confidence: 0.9,
    updatedAt: "2026-07-18T00:00:00.000Z",
    activeVersionId: null,
    versionCount: 2,
    evidence: { patternType: "workflow" },
    history: [],
    versions: [
      { id: VERSION_1, name: "Version 1", createdAt: "2026-07-17T00:00:00.000Z", active: false, metadata: {} },
      { id: VERSION_2, name: "Version 2", createdAt: "2026-07-18T00:00:00.000Z", active: false, metadata: {} },
    ],
    ...overrides,
  };
}

function requestBody(body?: unknown, raw?: string) {
  const chunks = raw !== undefined ? [Buffer.from(raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function response() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

async function call(method: string, path: string, body?: unknown, role: Role = "operator", raw?: string) {
  const req = requestBody(body, raw);
  const res = response();
  const broadcastAll = vi.fn();
  const handled = await handleMemoryLearningRoutes(
    method,
    new URL(`http://127.0.0.1${path}`),
    req as unknown as Parameters<typeof handleMemoryLearningRoutes>[2],
    res as unknown as Parameters<typeof handleMemoryLearningRoutes>[3],
    { broadcastAll } as unknown as Parameters<typeof handleMemoryLearningRoutes>[4],
    role,
  );
  return {
    handled,
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) as Record<string, unknown> : null,
    broadcastAll,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = "assisted";
  mocks.service.list.mockReturnValue([item()]);
  mocks.service.detail.mockReturnValue(item());
  mocks.service.action.mockReturnValue(item({ state: "active", activeVersionId: VERSION_2 }));
});

describe("memory learning API", () => {
  it("returns the live mode, list, and detail contracts without broadcasting", async () => {
    mocks.mode = "autonomous";
    const list = await call("GET", "/api/memory/learning");
    const detail = await call("GET", `/api/memory/learning/${ID}`);

    expect(list).toMatchObject({ handled: true, status: 200, body: { mode: "autonomous", items: [expect.objectContaining({ id: ID })] } });
    expect(detail).toMatchObject({ handled: true, status: 200, body: { item: expect.objectContaining({ id: ID }) } });
    expect(list.broadcastAll).not.toHaveBeenCalled();
    expect(detail.broadcastAll).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown valid item and 400 for a malformed id", async () => {
    mocks.service.detail.mockReturnValueOnce(null);
    expect(await call("GET", "/api/memory/learning/learned-aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ status: 404 });
    expect(await call("GET", "/api/memory/learning/not-valid")).toMatchObject({ status: 400 });
  });

  it("strictly rejects invalid JSON, actions, CAS values, and extra fields", async () => {
    expect(await call("POST", `/api/memory/learning/${ID}/action`, undefined, "operator", "{bad")).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "invent", expectedActiveVersionId: null })).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "activate" })).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "archive", expectedActiveVersionId: "stale" })).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "reject", versionId: VERSION_1 })).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "reject", expectedActiveVersionId: VERSION_1 })).toMatchObject({ status: 400 });
    expect(await call("POST", `/api/memory/learning/${ID}/action`, { action: "reject", expectedActiveVersionId: null, extra: true })).toMatchObject({ status: 400 });
    expect(mocks.service.action).not.toHaveBeenCalled();
  });

  it("accepts the exact reject payload serialized by the UI", async () => {
    mocks.service.action.mockReturnValueOnce(item({ state: "rejected" }));
    const result = await call("POST", `/api/memory/learning/${ID}/action`, {
      action: "reject",
      expectedActiveVersionId: null,
    });

    expect(result.status).toBe(200);
    expect(mocks.service.action).toHaveBeenCalledWith(ID, { action: "reject" });
    expect(result.broadcastAll).toHaveBeenCalledTimes(1);
    expect(result.broadcastAll).toHaveBeenCalledWith({ type: "learning_changed", id: ID, action: "reject" });
  });

  it.each<Role>(["agent", "user", "readonly"])("denies mutation to the %s role", async (role) => {
    const result = await call("POST", `/api/memory/learning/${ID}/action`, { action: "activate", expectedActiveVersionId: null }, role);
    expect(result.status).toBe(403);
    expect(mocks.service.action).not.toHaveBeenCalled();
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("delegates activate-without-version to the service and broadcasts exactly once", async () => {
    const result = await call("POST", `/api/memory/learning/${ID}/action`, {
      action: "activate",
      expectedActiveVersionId: null,
    });

    expect(result.status).toBe(200);
    expect(mocks.service.action).toHaveBeenCalledWith(ID, { action: "activate", expectedActiveVersionId: null });
    expect(result.broadcastAll).toHaveBeenCalledTimes(1);
    expect(result.broadcastAll).toHaveBeenCalledWith({ type: "learning_changed", id: ID, action: "activate" });
  });

  it("returns 409 for stale CAS without broadcasting", async () => {
    mocks.service.action.mockImplementationOnce(() => { throw new Error("Active learned protocol version changed: expected none, found current"); });
    const result = await call("POST", `/api/memory/learning/${ID}/action`, {
      action: "rollback",
      versionId: VERSION_1,
      expectedActiveVersionId: VERSION_2,
    });

    expect(result.status).toBe(409);
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("does not broadcast a successful no-op", async () => {
    const unchanged = item();
    mocks.service.detail.mockReturnValueOnce(unchanged);
    mocks.service.action.mockReturnValueOnce(structuredClone(unchanged));
    const result = await call("POST", `/api/memory/learning/${ID}/action`, { action: "activate", expectedActiveVersionId: null });

    expect(result.status).toBe(200);
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("returns a safe 500 for service failures without leaking or broadcasting", async () => {
    mocks.service.action.mockImplementationOnce(() => { throw new Error("secret /Users/name/private.json stack"); });
    const result = await call("POST", `/api/memory/learning/${ID}/action`, { action: "archive", expectedActiveVersionId: null });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Learning request failed" });
    expect(JSON.stringify(result.body)).not.toContain("private.json");
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });
});
