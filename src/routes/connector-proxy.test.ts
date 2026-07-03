/**
 * Connector proxy — manifest validation + allow-list matching.
 *
 * These are the security-relevant pure parts: a manifest that validates wrong
 * either bricks a working connector or (worse) forwards something it
 * shouldn't. The HTTP forwarding itself is a thin fetch passthrough exercised
 * live; auth-gate coverage for /api/connectors lives in
 * server/request-handler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DNS resolution so a public-looking hostname can be made to "resolve" to a
// private/metadata IP without touching the network — exercising the connect-time
// SSRF guard's DNS-rebind path (resolveAndPinHost → node:dns).
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, resolve4: vi.fn(), resolve6: vi.fn() },
  };
});

import { promises as dns } from "node:dns";
import { parseManifest, matchAllow, forwardWithTimeout } from "./connector-proxy.js";

const resolve4 = dns.resolve4 as unknown as ReturnType<typeof vi.fn>;
const resolve6 = dns.resolve6 as unknown as ReturnType<typeof vi.fn>;

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
    resolve4.mockReset();
    resolve6.mockReset();
  });

  // The core skeptic break: an upstream that PASSES the parse-time string check
  // (a public wildcard-DNS host, zero attacker setup) but RESOLVES to the cloud
  // metadata / private range. Parse-time-only code dials it happily; the pinning
  // dispatcher must refuse the connection once DNS reveals the private address.
  it("blocks an https upstream whose hostname resolves to a private/metadata IP", async () => {
    resolve4.mockResolvedValue(["169.254.169.254"]); // e.g. 169.254.169.254.nip.io
    resolve6.mockResolvedValue([]);

    await expectSsrfBlocked("https://169-254-169-254.nip.io/latest/meta-data/");

    // Proof the block happened at CONNECT time, after resolving the host —
    // not by a parse-time string check (the host is not an IP literal).
    expect(resolve4).toHaveBeenCalledWith("169-254-169-254.nip.io");
  });

  it("also blocks an https upstream whose hostname resolves to an RFC1918 IP", async () => {
    resolve4.mockResolvedValue(["10.0.0.5"]);
    resolve6.mockResolvedValue([]);

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
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });
});
