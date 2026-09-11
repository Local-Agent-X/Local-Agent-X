import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { authorizeRequest } from "./request-auth.js";
import { getAuthFloodGuard, isLoopbackAddress } from "../server-utils.js";
import type { LAXConfig } from "../types.js";
import type { RBACManager } from "../rbac.js";

// Minimal request/response stubs so we can inspect the status the auth
// pipeline writes without booting a real HTTP server.
function makeReq(opts: {
  method?: string;
  path?: string;
  ip?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { socket: { remoteAddress: string } };
  req.method = opts.method ?? "GET";
  req.url = opts.path ?? "/api/settings";
  req.headers = opts.headers ?? {};
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: opts.ip ?? "127.0.0.1" };
  return req;
}

function makeRes(): ServerResponse & { _status: number; _body: string } {
  const res = new EventEmitter() as unknown as ServerResponse & { _status: number; _body: string };
  res._status = 0;
  res._body = "";
  (res as unknown as { writeHead: (status: number) => unknown }).writeHead = (status: number) => { res._status = status; return res; };
  (res as unknown as { end: (body?: string) => unknown }).end = (body?: string) => { res._body = body ?? ""; return res; };
  return res;
}

const config = { authToken: "correct-token" } as unknown as LAXConfig;

// RBAC stub that only accepts the config token.
const rbac = {
  authenticate: (t: string) => t === "correct-token"
    ? { valid: true, entry: { role: "operator" as const } }
    : { valid: false },
  checkEndpoint: () => ({ allowed: true }),
  listTokens: () => [],
} as unknown as RBACManager;

describe("isLoopbackAddress", () => {
  it("recognizes IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.99")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
  });
  it("recognizes IPv6 loopback and IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects non-loopback addresses", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("authorizeRequest — loopback bypasses throttling", () => {
  beforeEach(() => { getAuthFloodGuard().clear(); });

  it("does not lock out a loopback IP after many failed auths", () => {
    // 50 wrong-token requests in a row from 127.0.0.1. If the flood guard
    // were still active for loopback, this would flip to 429 partway through
    // (default AUTH_MAX_FAILURES is single-digit). Every response must be 401.
    for (let i = 0; i < 50; i++) {
      const req = makeReq({ method: "POST", path: "/api/settings", headers: { authorization: "Bearer nope" } });
      const res = makeRes();
      authorizeRequest("POST", new URL("http://127.0.0.1:7007/api/settings"), req, res, config, rbac);
      expect(res._status).toBe(401);
    }
    expect(getAuthFloodGuard().has("127.0.0.1")).toBe(false);
  });

  it("still lets loopback in when the token is correct", () => {
    const req = makeReq({ method: "GET", path: "/api/settings", headers: { authorization: "Bearer correct-token" } });
    const res = makeRes();
    const out = authorizeRequest("GET", new URL("http://127.0.0.1:7007/api/settings"), req, res, config, rbac);
    expect(out.handled).toBe(false);
    expect(res._status).toBe(0); // no response written — request continues to the route handler
  });

  it("preserves flood-guard behavior for a non-loopback IP", () => {
    // A non-loopback client (in practice already rejected earlier by the
    // origin check, but this is defense-in-depth) still triggers the flood
    // guard on repeated bad tokens.
    for (let i = 0; i < 20; i++) {
      const req = makeReq({ ip: "203.0.113.5", method: "POST", path: "/api/settings", headers: { authorization: "Bearer nope" } });
      const res = makeRes();
      authorizeRequest("POST", new URL("http://127.0.0.1:7007/api/settings"), req, res, config, rbac);
    }
    // After enough failures the guard has an entry with a lockedUntil in the future.
    const entry = getAuthFloodGuard().get("203.0.113.5");
    expect(entry).toBeDefined();
    expect(entry!.lockedUntil).toBeGreaterThan(Date.now());
  });
});
