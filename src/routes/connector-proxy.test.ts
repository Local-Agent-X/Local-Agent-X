/**
 * Connector proxy — manifest validation + allow-list matching.
 *
 * These are the security-relevant pure parts: a manifest that validates wrong
 * either bricks a working connector or (worse) forwards something it
 * shouldn't. The HTTP forwarding itself is a thin fetch passthrough exercised
 * live; auth-gate coverage for /api/connectors lives in
 * server/request-handler.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock DNS resolution so a public-looking hostname can be made to "resolve" to a
// private/metadata IP without touching the network — exercising the connect-time
// SSRF guard's DNS-rebind path (resolveAndPinHost → node:dns).
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, lookup: vi.fn() },
  };
});

import { promises as dns } from "node:dns";
import { parseManifest, matchAllow, forwardWithTimeout } from "./connector-proxy.js";

const lookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

// undici's fetch wraps a connect.lookup rejection as a generic
// `TypeError: fetch failed`, stashing the real SSRF reason in `.cause` (which
// itself nests one more level). Walk the whole cause chain so the assertion
// sees the connect-time block reason, not the opaque top-level message. On
// parse-time-only code the request is dialed by a plain fetch that never
// consults the mocked resolver, so it fails with a bare connect error whose
// chain carries NO SSRF reason — this assertion FAILS there, as required.
function causeChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur instanceof Error && i < 8; i++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

async function expectSsrfBlocked(u: string): Promise<void> {
  let thrown: unknown;
  try {
    await forwardWithTimeout(u, { method: "GET", headers: {} }, 5000, /* isLocalUpstream */ false);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected forwardWithTimeout to reject").toBeInstanceOf(Error);
  expect(causeChain(thrown)).toMatch(/private|rebinding|reserved|SSRF/i);
}

const VALID = {
  upstream: "https://api.fastmail.com",
  auth: { type: "bearer", secret: "FASTMAIL" },
  allow: ["GET /jmap/session", "POST /jmap/api"],
};

describe("parseManifest", () => {
  it("accepts a minimal bearer manifest", () => {
    const r = parseManifest(JSON.stringify(VALID));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.upstream).toBe("https://api.fastmail.com");
  });

  it("strips trailing slashes from upstream", () => {
    const r = parseManifest(JSON.stringify({ ...VALID, upstream: "https://api.fastmail.com/" }));
    expect(r.ok && r.manifest.upstream).toBe("https://api.fastmail.com");
  });

  it("rejects non-JSON and non-object manifests", () => {
    expect(parseManifest("not json").ok).toBe(false);
    expect(parseManifest("[1,2]").ok).toBe(false);
  });

  it("rejects http upstreams (except localhost) and upstreams with a path", () => {
    expect(parseManifest(JSON.stringify({ ...VALID, upstream: "http://api.fastmail.com" })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, upstream: "https://api.fastmail.com/jmap" })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, upstream: "http://127.0.0.1:8080" })).ok).toBe(true);
    expect(parseManifest(JSON.stringify({ ...VALID, upstream: "http://localhost:11434" })).ok).toBe(true);
  });

  it("requires a secret name for bearer/header auth, header name for header auth", () => {
    expect(parseManifest(JSON.stringify({ ...VALID, auth: { type: "bearer" } })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, auth: { type: "header", secret: "K" } })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, auth: { type: "header", header: "X-Api-Key", secret: "K" } })).ok).toBe(true);
    expect(parseManifest(JSON.stringify({ ...VALID, auth: { type: "none" } })).ok).toBe(true);
    expect(parseManifest(JSON.stringify({ ...VALID, auth: { type: "basic", secret: "K" } })).ok).toBe(false);
  });

  it("requires a non-empty, well-formed allow list", () => {
    expect(parseManifest(JSON.stringify({ ...VALID, allow: [] })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, allow: ["jmap/api"] })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, allow: ["FETCH /x"] })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, allow: ["GET /0/public/*"] })).ok).toBe(true);
  });

  it("refuses forwarding LAX's own auth headers upstream", () => {
    expect(parseManifest(JSON.stringify({ ...VALID, forwardHeaders: ["Authorization"] })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, forwardHeaders: ["Cookie"] })).ok).toBe(false);
    expect(parseManifest(JSON.stringify({ ...VALID, forwardHeaders: ["API-Key", "API-Sign"] })).ok).toBe(true);
  });

  it("clamps timeoutMs into [1s, 120s]", () => {
    const low = parseManifest(JSON.stringify({ ...VALID, timeoutMs: 5 }));
    const high = parseManifest(JSON.stringify({ ...VALID, timeoutMs: 9_999_999 }));
    expect(low.ok && low.manifest.timeoutMs).toBe(1000);
    expect(high.ok && high.manifest.timeoutMs).toBe(120_000);
  });
});

describe("matchAllow", () => {
  const allow = ["GET /jmap/session", "POST /jmap/api", "GET /0/public/*"];

  it("matches exact method + path", () => {
    expect(matchAllow(allow, "GET", "/jmap/session")).toBe(true);
    expect(matchAllow(allow, "POST", "/jmap/api")).toBe(true);
  });

  it("rejects wrong method, unlisted path, and prefix-of-exact tricks", () => {
    expect(matchAllow(allow, "POST", "/jmap/session")).toBe(false);
    expect(matchAllow(allow, "GET", "/jmap")).toBe(false);
    expect(matchAllow(allow, "GET", "/jmap/session/extra")).toBe(false);
    expect(matchAllow(allow, "DELETE", "/jmap/api")).toBe(false);
  });

  it("wildcard matches the subtree and the bare prefix, not lookalike siblings", () => {
    expect(matchAllow(allow, "GET", "/0/public/Time")).toBe(true);
    expect(matchAllow(allow, "GET", "/0/public/Depth/deep")).toBe(true);
    expect(matchAllow(allow, "GET", "/0/public")).toBe(true);
    expect(matchAllow(allow, "GET", "/0/publicX")).toBe(false);
    expect(matchAllow(allow, "GET", "/0/private/Balance")).toBe(false);
  });
});

describe("forwardWithTimeout connect-time SSRF guard", () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  // The core skeptic break: an upstream that PASSES the parse-time string check
  // (a public wildcard-DNS host, zero attacker setup) but RESOLVES to the cloud
  // metadata / private range. Parse-time-only code dials it happily; the pinning
  // dispatcher must refuse the connection once DNS reveals the private address.
  it("blocks an https upstream whose hostname resolves to a private/metadata IP", async () => {
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]); // e.g. 169.254.169.254.nip.io

    await expectSsrfBlocked("https://169-254-169-254.nip.io/latest/meta-data/");

    // Proof the block happened at CONNECT time, after resolving the host —
    // not by a parse-time string check (the host is not an IP literal).
    expect(lookup).toHaveBeenCalledWith("169-254-169-254.nip.io", { all: true });
  });

  it("also blocks an https upstream whose hostname resolves to an RFC1918 IP", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    await expectSsrfBlocked("https://internal.attacker-controlled.example/x");
  });

  // The sanctioned loopback dev carve-out must NOT go through the pinning
  // dispatcher (a loopback resolve would be refused). It uses a plain fetch, so
  // the SSRF resolver is never consulted for it.
  it("does not route the sanctioned localhost dev carve-out through the resolver", async () => {
    // Unused loopback port → connection refused fast; we only care that the
    // pinning resolver was never consulted for the local carve-out.
    await expect(
      forwardWithTimeout("http://127.0.0.1:1/health", { method: "GET", headers: {} }, 1000, true),
    ).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses redirects instead of forwarding connector credentials to a second origin", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { Location: "https://attacker.example/collect" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const dataDir = mkdtempSync(join(tmpdir(), "lax-connector-redirect-"));
    const prevDir = process.env.LAX_DATA_DIR;
    try {
      if (!address || typeof address === "string") throw new Error("missing test port");
      // A local upstream answers to the loopback grant; this one is registered.
      process.env.LAX_DATA_DIR = dataDir;
      writeFileSync(join(dataDir, "security.json"), JSON.stringify({ localServicePorts: [address.port] }));
      await expect(forwardWithTimeout(
        `http://127.0.0.1:${address.port}/redirect`,
        { method: "GET", headers: { Authorization: "Bearer secret" } },
        1000,
        true,
      )).rejects.toThrow(/redirects are disabled/i);
    } finally {
      if (prevDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDir;
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// connector_create takes its upstream from the model, and a local upstream was
// forwarded with a plain fetch: any loopback port, the in-app browser's
// debugging port included, was reachable through an agent-built app. A local
// upstream now answers to the same loopback grant every agent path does.
describe("forwardWithTimeout: a local upstream answers to the loopback grant", () => {
  let server: Server;
  let port: number;
  let hits: number;
  let dataDir: string;
  const prevDir = process.env.LAX_DATA_DIR;
  beforeEach(async () => {
    hits = 0;
    server = createServer((_req, res) => { hits++; res.writeHead(200); res.end("ok"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    dataDir = mkdtempSync(join(tmpdir(), "lax-connector-loopback-"));
    process.env.LAX_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    delete process.env.LAX_ELECTRON_CDP_PORT;
    if (prevDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDir;
    rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const register = () => writeFileSync(join(dataDir, "security.json"), JSON.stringify({ localServicePorts: [port] }));

  it("an unregistered local port is refused before anything is sent", async () => {
    await expect(forwardWithTimeout(`http://127.0.0.1:${port}/json/version`, { method: "GET", headers: {} }, 2000, true)).rejects.toThrow();
    await expect(forwardWithTimeout(`http://localhost:${port}/json/version`, { method: "GET", headers: {} }, 2000, true)).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it("a registered local service is forwarded as before", async () => {
    register();
    const r = await forwardWithTimeout(`http://127.0.0.1:${port}/health`, { method: "GET", headers: {} }, 2000, true);
    expect(r.status).toBe(200);
    expect(hits).toBe(1);
  });

  it("the reserved debugging port is refused even when registered", async () => {
    register();
    process.env.LAX_ELECTRON_CDP_PORT = String(port);
    await expect(forwardWithTimeout(`http://127.0.0.1:${port}/json/version`, { method: "GET", headers: {} }, 2000, true)).rejects.toThrow();
    expect(hits).toBe(0);
  });
});
