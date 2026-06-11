/**
 * Connector proxy — manifest validation + allow-list matching.
 *
 * These are the security-relevant pure parts: a manifest that validates wrong
 * either bricks a working connector or (worse) forwards something it
 * shouldn't. The HTTP forwarding itself is a thin fetch passthrough exercised
 * live; auth-gate coverage for /api/connectors lives in
 * server/request-handler.test.ts.
 */
import { describe, it, expect } from "vitest";
import { parseManifest, matchAllow } from "./connector-proxy.js";

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
