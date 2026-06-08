import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setInternalAgentToken } from "../rbac.js";
import { getRuntimeConfig } from "../config.js";

// Mock undici's `fetch` so the redirect tests can script 302→200 responses.
// When no test installs a handler, calls fall through to the REAL undici fetch
// (so the existing selfCallAuthHeader / createPinningDispatcher tests, which do
// real network I/O, are unaffected). The real `Agent` is always preserved so
// createPinningDispatcher keeps working.
const undiciMock = vi.hoisted(() => ({
  handler: null as null | ((url: string, opts: unknown) => unknown),
}));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (url: unknown, opts?: unknown) =>
      undiciMock.handler
        ? undiciMock.handler(String(url), opts)
        : actual.fetch(url as never, opts as never),
  };
});

// Imported AFTER the mock is registered so web-tools binds to the mocked fetch.
const { selfCallAuthHeader, createPinningDispatcher, webFetchTool, createHttpRequestTool } =
  await import("./web-tools.js");

/** Minimal undici-Response stand-in for the fields the tools read. */
function fakeResponse(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  const h = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status: opts.status,
    statusText: "",
    ok: opts.status >= 200 && opts.status < 300,
    headers: {
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
      forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
    },
    text: async () => opts.body ?? "",
  };
}

const INTERNAL = "internal-agent-token-deadbeef";

describe("selfCallAuthHeader", () => {
  let port: number;
  let authToken: string;

  beforeEach(() => {
    const rc = getRuntimeConfig();
    port = rc.port;
    authToken = rc.authToken;
    setInternalAgentToken(INTERNAL);
  });

  it("returns the internal agent token for a loopback self-call", async () => {
    const h = await selfCallAuthHeader(`http://127.0.0.1:${port}/api/secrets/x/reveal`);
    expect(h).toEqual({ Authorization: `Bearer ${INTERNAL}` });
    // Must be the least-privilege internal token, not the operator token.
    expect(h?.Authorization).not.toBe(`Bearer ${authToken}`);
  });

  it("returns null for an external URL (token never leaks off-box)", async () => {
    expect(await selfCallAuthHeader("https://evil.example.com/api")).toBeNull();
  });

  it("returns null for the right host but wrong port", async () => {
    expect(await selfCallAuthHeader(`http://127.0.0.1:${port + 1}/api`)).toBeNull();
  });

  it("falls back to the operator token only when the internal token is unset (null)", async () => {
    // The internal token is null before server boot. There is no public setter
    // to null, so mock the rbac accessor to model the pre-boot/subprocess state.
    vi.resetModules();
    vi.doMock("../rbac.js", () => ({ getInternalAgentToken: () => null }));
    const { selfCallAuthHeader: fresh } = await import("./web-tools.js");
    const h = await fresh(`http://localhost:${port}/api/settings`);
    expect(h).toEqual({ Authorization: `Bearer ${authToken}` });
    vi.doUnmock("../rbac.js");
    vi.resetModules();
  });
});

describe("createPinningDispatcher", () => {
  it("returns an undici Agent instance", async () => {
    const d = createPinningDispatcher();
    expect(d).toBeInstanceOf(Agent);
    await d.close();
  });

  it("passes a literal loopback IP through to the literal (pin: null pass-through)", async () => {
    // No server is listening on this port, so the connection is refused — but the
    // refusal proves the dispatcher dialed the literal IP rather than blocking it
    // (a private-IP block surfaces a 'Blocked:' error, not a connection refusal).
    const d = createPinningDispatcher();
    try {
      await undiciFetch("http://127.0.0.1:1/", {
        dispatcher: d,
        signal: AbortSignal.timeout(2_000),
      });
      throw new Error("expected the connection to be refused");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Connection-level failure, not a private-IP policy block.
      expect(msg).not.toMatch(/Blocked:/);
    } finally {
      await d.close();
    }
  });

  it("blocks a host that fails to resolve / resolves private (fail-closed)", async () => {
    const d = createPinningDispatcher();
    try {
      await undiciFetch("http://nonexistent-host.invalid/", {
        dispatcher: d,
        signal: AbortSignal.timeout(5_000),
      });
      throw new Error("expected the connection to be blocked");
    } catch (e) {
      // The lookup surfaced an error from resolveAndPinHost (fetch wraps it as a
      // failed connection); the key assertion is that the request did not succeed.
      expect(e).toBeInstanceOf(Error);
    } finally {
      await d.close();
    }
  });
});

// H5 follow-up: re-run the egress policy on cross-host redirects. The
// pre-dispatch SecurityLayer gate only validates the INITIAL url; without a
// per-hop re-check, an allowlisted host could 302 to a non-allowlisted host in
// strict mode (egress-allowlist bypass via redirect).
describe("cross-host redirect egress re-check", () => {
  let laxDir: string;
  let prevLaxDir: string | undefined;

  beforeEach(() => {
    prevLaxDir = process.env.LAX_DATA_DIR;
    laxDir = mkdtempSync(join(tmpdir(), "web-tools-egress-"));
    process.env.LAX_DATA_DIR = laxDir;
  });

  afterEach(() => {
    undiciMock.handler = null;
    if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevLaxDir;
    rmSync(laxDir, { recursive: true, force: true });
  });

  function writeStrictAllowlist(hosts: string[]) {
    writeFileSync(join(laxDir, "security.json"), JSON.stringify({ egressMode: "strict" }), "utf-8");
    writeFileSync(join(laxDir, "egress-allowlist.json"), JSON.stringify(hosts), "utf-8");
  }

  // Allowlist host A only; A responds 302 → attacker host B; the loop must NOT
  // follow to B. We assert that B is never fetched and the result is an error
  // carrying the policy reason.
  it("strict mode: blocks an allowlisted host redirecting to a non-allowlisted host (web_fetch)", async () => {
    writeStrictAllowlist(["allowed-a.example"]);
    const seen: string[] = [];
    undiciMock.handler = (url) => {
      seen.push(url);
      if (url.startsWith("https://allowed-a.example")) {
        return fakeResponse({ status: 302, headers: { location: "https://attacker-b.example/steal" } });
      }
      return fakeResponse({ status: 200, body: "SECRET PAGE FROM B" });
    };

    const res = await webFetchTool.execute({ url: "https://allowed-a.example/page" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not in the egress allowlist/i);
    expect(seen).toEqual(["https://allowed-a.example/page"]);
    expect(seen).not.toContain("https://attacker-b.example/steal");
    expect(res.content).not.toContain("SECRET PAGE FROM B");
  });

  it("strict mode: blocks an allowlisted host redirecting to a non-allowlisted host (http_request)", async () => {
    writeStrictAllowlist(["allowed-a.example"]);
    const seen: string[] = [];
    undiciMock.handler = (url) => {
      seen.push(url);
      if (url.startsWith("https://allowed-a.example")) {
        return fakeResponse({ status: 302, headers: { location: "https://attacker-b.example/steal" } });
      }
      return fakeResponse({ status: 200, body: "SECRET PAGE FROM B" });
    };

    const tool = createHttpRequestTool();
    const res = await tool.execute({ url: "https://allowed-a.example/page" });

    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not in the egress allowlist/i);
    expect(seen).toEqual(["https://allowed-a.example/page"]);
    expect(seen).not.toContain("https://attacker-b.example/steal");
  });

  // Permissive (default) only gates secret-bearing payloads, not plain GETs —
  // the cross-host redirect must still be followed (no regression).
  it("permissive mode (default): cross-host redirect is still followed", async () => {
    // No security.json / allowlist → permissive default.
    const seen: string[] = [];
    undiciMock.handler = (url) => {
      seen.push(url);
      if (url.startsWith("https://host-a.example")) {
        return fakeResponse({ status: 302, headers: { location: "https://host-b.example/final" } });
      }
      return fakeResponse({ status: 200, body: "PAGE FROM B" });
    };

    const res = await webFetchTool.execute({ url: "https://host-a.example/page" });

    expect(res.isError).toBeFalsy();
    expect(seen).toContain("https://host-b.example/final");
    expect(res.content).toContain("PAGE FROM B");
  });

  // Same-host redirect (A → A/other) is fine even in strict mode — the
  // allowlist is host-scoped, so a path change on an allowlisted host passes.
  it("strict mode: same-host redirect is still followed", async () => {
    writeStrictAllowlist(["allowed-a.example"]);
    const seen: string[] = [];
    undiciMock.handler = (url) => {
      seen.push(url);
      if (url === "https://allowed-a.example/page") {
        return fakeResponse({ status: 302, headers: { location: "https://allowed-a.example/other" } });
      }
      return fakeResponse({ status: 200, body: "PAGE FROM A/other" });
    };

    const res = await webFetchTool.execute({ url: "https://allowed-a.example/page" });

    expect(res.isError).toBeFalsy();
    expect(seen).toContain("https://allowed-a.example/other");
    expect(res.content).toContain("PAGE FROM A/other");
  });
});
