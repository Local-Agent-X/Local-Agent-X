// A call http_request makes to this server's own port authenticates as the
// agent, whatever credential the model wrote into args.headers. The agent-role
// RBAC denials (rbac-agent-denials.ts) are what keep the agent off the routes
// that flip its own leash; a model-supplied operator token used to replace the
// injected agent header and walk past every one of them.
//
// The real tool runs against a scripted undici fetch that records the headers
// each request carried; the real RBACManager says which principal they name.
// The same credential-header rule decides what a cross-origin redirect sheds.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sent = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; headers: Record<string, string> }>,
  redirects: new Map<string, string>(),
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (url: unknown, opts?: { headers?: Record<string, string> }) => {
      sent.calls.push({ url: String(url), headers: { ...(opts?.headers ?? {}) } });
      const location = sent.redirects.get(String(url));
      const h = new Map([["content-type", "application/json"], ...(location ? [["location", location] as [string, string]] : [])]);
      return {
        status: location ? 302 : 200,
        statusText: location ? "Found" : "OK",
        ok: !location,
        headers: {
          get: (k: string) => h.get(k.toLowerCase()) ?? null,
          forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
        },
        text: async () => '{"ok":true}',
      };
    },
  };
});

const { createHttpRequestTool } = await import("./http-request.js");
const { getRuntimeConfig } = await import("../config.js");
const { RBACManager, setInternalAgentToken } = await import("../rbac.js");
const { getLaxDir } = await import("../lax-data-dir.js");
import type { SecretsStore } from "../secrets.js";

/** The principal a recorded request authenticates as on the real RBAC table. */
function principalOf(headers: Record<string, string>, rbac: InstanceType<typeof RBACManager>): string {
  const auth = Object.entries(headers).filter(([k]) => k.toLowerCase() === "authorization").map(([, v]) => v);
  if (auth.length !== 1 || !auth[0].startsWith("Bearer ")) return `unauthenticated (${auth.length} authorization headers)`;
  const r = rbac.authenticate(auth[0].slice(7));
  return r.valid && r.entry ? r.entry.role : "rejected";
}

describe("http_request: a call to this server's own port always runs as the agent", () => {
  let operatorToken: string;
  let port: number;
  let rbacDir: string;
  let rbac: InstanceType<typeof RBACManager>;
  const SECURITY_ROUTE = "/api/security/file-access";

  // A user who trusts their own machine as a destination: the outbound secret
  // scan then lets a literal credential through to loopback, which is the case
  // where only the header rule stands between the model and the operator role.
  const allowlist = (): string => join(getLaxDir(), "egress-allowlist.json");
  const trustLoopback = (): void => writeFileSync(allowlist(), JSON.stringify(["127.0.0.1", "localhost.localdomain"]));

  beforeAll(() => {
    const rc = getRuntimeConfig();
    operatorToken = rc.authToken;
    port = rc.port;
    rbacDir = mkdtempSync(join(tmpdir(), "lax-selfcall-rbac-"));
    rbac = new RBACManager(rbacDir, operatorToken);
    setInternalAgentToken(rbac.getInternalAgentToken());
  });
  afterAll(() => rmSync(rbacDir, { recursive: true, force: true }));
  beforeEach(() => {
    sent.calls.length = 0;
    sent.redirects.clear();
    rmSync(allowlist(), { force: true });
  });

  it("sanity: the operator token opens the security route and the agent token does not", () => {
    expect(rbac.checkEndpoint("operator", "POST", SECURITY_ROUTE).allowed).toBe(true);
    expect(rbac.checkEndpoint("agent", "POST", SECURITY_ROUTE).allowed).toBe(false);
  });

  it("a model-supplied operator Authorization header is dropped and the agent token is sent", async () => {
    trustLoopback();
    const res = await createHttpRequestTool().execute({
      url: `http://127.0.0.1:${port}${SECURITY_ROUTE}`,
      method: "POST",
      headers: { Authorization: `Bearer ${operatorToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "unrestricted" }),
    });
    expect(sent.calls).toHaveLength(1);
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
    expect(sent.calls[0].headers["Content-Type"]).toBe("application/json");
    expect(res.content).toMatch(/Dropped the Authorization header/);
    expect(res.metadata?.dropped_headers).toEqual(["Authorization"]);
  });

  it("without a trusted loopback, a literal operator token is refused before anything is sent", async () => {
    const res = await createHttpRequestTool().execute({
      url: `http://127.0.0.1:${port}${SECURITY_ROUTE}`,
      method: "POST",
      headers: { Authorization: `Bearer ${operatorToken}` },
      body: "{}",
    });
    expect(sent.calls).toHaveLength(0);
    expect(res.content).toMatch(/secret-shaped content/);
    expect(res.content).not.toContain(operatorToken);
  });

  it("a lowercase spelling cannot ride alongside the injected header", async () => {
    trustLoopback();
    await createHttpRequestTool().execute({
      url: `http://127.0.0.1:${port}${SECURITY_ROUTE}`,
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}` },
      body: "{}",
    });
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
  });

  // No allowlist needed here: the scan sees only the placeholder.
  it("an operator token resolved from a {{SECRET}} placeholder is dropped too", async () => {
    const secrets = {
      findMissing: () => [],
      resolve: (s: string) => s.replace("{{LAX_OPERATOR}}", operatorToken),
    } as unknown as SecretsStore;
    await createHttpRequestTool(secrets).execute({
      url: `http://127.0.0.1:${port}${SECURITY_ROUTE}`,
      method: "POST",
      headers: { Authorization: "Bearer {{LAX_OPERATOR}}" },
      body: "{}",
    });
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
  });

  it("a loopback alias name for the same port carries no model credential either, only the agent's", async () => {
    trustLoopback();
    const res = await createHttpRequestTool().execute({
      url: `http://localhost.localdomain:${port}${SECURITY_ROUTE}`,
      method: "POST",
      headers: { Authorization: `Bearer ${operatorToken}` },
      body: "{}",
    });
    expect(sent.calls).toHaveLength(1);
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
    expect(res.metadata?.dropped_headers).toEqual(["Authorization"]);
  });

  it("cookies and x-*-token headers are dropped; ordinary headers are kept", async () => {
    await createHttpRequestTool().execute({
      url: `http://127.0.0.1:${port}/api/settings`,
      method: "GET",
      headers: { Cookie: "lax_token=abc", "X-Auth-Token": "abc", "X-Request-Id": "r-1", "X-Idempotency-Key": "k-1" },
    });
    const names = Object.keys(sent.calls[0].headers).map((k) => k.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("x-auth-token");
    expect(names).toContain("x-request-id");
    expect(names).toContain("x-idempotency-key");
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
  });

  it("a self-call with no credential header carries no note", async () => {
    const res = await createHttpRequestTool().execute({ url: `http://127.0.0.1:${port}/api/settings` });
    expect(principalOf(sent.calls[0].headers, rbac)).toBe("agent");
    expect(res.content).not.toMatch(/Dropped/);
    expect(res.metadata?.dropped_headers).toBeUndefined();
  });

  it("a request to another host keeps the model's Authorization header", async () => {
    const res = await createHttpRequestTool().execute({
      url: "https://api.example.com/v1/items",
      headers: { Authorization: "Bearer short" },
    });
    expect(sent.calls[0].headers.Authorization).toBe("Bearer short");
    expect(res.metadata?.dropped_headers).toBeUndefined();
  });
});

describe("http_request: credential headers do not follow a cross-origin redirect", () => {
  beforeEach(() => {
    sent.calls.length = 0;
    sent.redirects.clear();
  });

  it("the next origin gets no Authorization, Cookie or x-*-token; ordinary headers carry on", async () => {
    sent.redirects.set("https://api.example.com/start", "https://cdn.example.org/next");
    await createHttpRequestTool().execute({
      url: "https://api.example.com/start",
      headers: { Authorization: "Bearer short", Cookie: "s=1", "X-Auth-Token": "t", "X-Request-Id": "r-1" },
    });
    expect(sent.calls.map((c) => c.url)).toEqual(["https://api.example.com/start", "https://cdn.example.org/next"]);
    expect(Object.keys(sent.calls[0].headers)).toEqual(expect.arrayContaining(["Authorization", "Cookie", "X-Auth-Token"]));
    const next = Object.keys(sent.calls[1].headers).map((k) => k.toLowerCase());
    expect(next).not.toContain("authorization");
    expect(next).not.toContain("cookie");
    expect(next).not.toContain("x-auth-token");
    expect(next).toContain("x-request-id");
  });

  it("a same-origin redirect keeps them", async () => {
    sent.redirects.set("https://api.example.com/start", "https://api.example.com/next");
    await createHttpRequestTool().execute({ url: "https://api.example.com/start", headers: { Authorization: "Bearer short" } });
    expect(sent.calls[1].headers.Authorization).toBe("Bearer short");
  });
});
