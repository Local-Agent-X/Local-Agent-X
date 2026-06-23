import { describe, it, expect } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { signRequest, validateSignedAuth, type SignedAuthConfig } from "./connector-signing.js";

// Reference implementation of Webull's OpenAPI signing — a faithful copy of the
// scheme so the general `signed` recipe below is proven to reproduce it byte for
// byte. If this and signRequest ever diverge for the webullConfig vectors, the
// recipe vocabulary has drifted from the real scheme.
function webullReference(args: {
  appKey: string; appSecret: string; path: string; query: string; host: string;
  body?: Buffer; timestamp: string; nonce: string;
}): string {
  const { appKey, appSecret, path, query, host, body, timestamp, nonce } = args;
  const headers: Record<string, string> = {
    "x-app-key": appKey,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": nonce,
    "x-timestamp": timestamp,
    "host": host,
  };
  const SIGNING = ["x-app-key", "x-signature-algorithm", "x-signature-version", "x-signature-nonce", "x-timestamp", "host"];
  const params = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(query)) params.set(k.toLowerCase(), v);
  for (const h of SIGNING) params.set(h, headers[h]);
  const strParams = [...params.keys()].sort().map(k => `${k}=${params.get(k)}`).join("&");
  const str2 = `${path}&${strParams}`;
  const str3 = body && body.length > 0
    ? `${str2}&${createHash("md5").update(body).digest("hex").toUpperCase()}`
    : str2;
  return createHmac("sha1", `${appSecret}&`).update(str3, "utf8").digest("base64");
}

const webullConfig: SignedAuthConfig = {
  type: "signed",
  algorithm: "hmac-sha1",
  secret: "WEBULL_APP_SECRET",
  keySuffix: "&",
  encoding: "base64",
  timestampFormat: "iso-no-ms",
  headers: {
    "x-app-key": "{vault:WEBULL_APP_KEY}",
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": "{nonce}",
    "x-timestamp": "{timestamp}",
    "x-version": "v2",
  },
  signedHeaders: ["x-app-key", "x-signature-algorithm", "x-signature-version", "x-signature-nonce", "x-timestamp", "host"],
  canonical: [
    { kind: "path" },
    { kind: "params", include: ["query", "signedHeaders"], sorted: true, lowerKeys: true },
    { kind: "bodyHash", algorithm: "md5", encoding: "hex", upper: true },
  ],
  separator: "&",
  signature: { in: "header", name: "x-signature" },
};

const APP_KEY = "test-app-key-123";
const APP_SECRET = "test-app-secret-xyz";
const HOST = "us-openapi-alb.uat.webullbroker.com";
const NOW = new Date("2026-06-23T00:41:56.123Z");
const TS = "2026-06-23T00:41:56Z"; // iso-no-ms of NOW
const NONCE = "fixed-nonce-0000-1111-2222";

function sign(method: string, path: string, query: string, body?: Buffer) {
  return signRequest({
    config: webullConfig,
    keyMaterial: APP_SECRET,
    vault: { WEBULL_APP_KEY: APP_KEY },
    method, path, query, host: HOST, body, now: NOW, nonce: NONCE,
  });
}

describe("signRequest — Webull scheme reproduced by the general `signed` recipe", () => {
  it("GET with no query and no body (the read-only account/list call)", () => {
    const r = sign("GET", "/openapi/account/list", "");
    const expected = webullReference({ appKey: APP_KEY, appSecret: APP_SECRET, path: "/openapi/account/list", query: "", host: HOST, timestamp: TS, nonce: NONCE });
    expect(r.headers["x-signature"]).toBe(expected);
    expect(r.headers["x-app-key"]).toBe(APP_KEY);
    expect(r.headers["x-timestamp"]).toBe(TS);
    expect(r.headers["x-signature-nonce"]).toBe(NONCE);
    expect(r.headers["x-version"]).toBe("v2"); // attached but not signed
    expect(r.queryAppend).toBeUndefined();
  });

  it("GET with query params", () => {
    const r = sign("GET", "/openapi/quotes", "symbols=AAPL&type=stock");
    const expected = webullReference({ appKey: APP_KEY, appSecret: APP_SECRET, path: "/openapi/quotes", query: "symbols=AAPL&type=stock", host: HOST, timestamp: TS, nonce: NONCE });
    expect(r.headers["x-signature"]).toBe(expected);
  });

  it("POST with a JSON body (body hash participates in the signature)", () => {
    const body = Buffer.from(JSON.stringify({ symbol: "AAPL", qty: 1, side: "BUY" }), "utf8");
    const r = sign("POST", "/openapi/orders/place", "", body);
    const expected = webullReference({ appKey: APP_KEY, appSecret: APP_SECRET, path: "/openapi/orders/place", query: "", host: HOST, body, timestamp: TS, nonce: NONCE });
    expect(r.headers["x-signature"]).toBe(expected);
  });

  it("body hash is omitted (no dangling separator) when there is no body", () => {
    const withoutBody = sign("GET", "/openapi/account/list", "");
    const withEmptyBody = sign("GET", "/openapi/account/list", "", Buffer.alloc(0));
    expect(withEmptyBody.headers["x-signature"]).toBe(withoutBody.headers["x-signature"]);
  });
});

describe("signRequest — placement and algorithm options", () => {
  it("places the signature in a query param when configured", () => {
    const cfg: SignedAuthConfig = {
      type: "signed", algorithm: "hmac-sha256", secret: "S",
      canonical: [{ kind: "method" }, { kind: "path" }],
      signature: { in: "query", name: "sig" },
    };
    const r = signRequest({ config: cfg, keyMaterial: "k", vault: {}, method: "get", path: "/x", query: "", host: "h", now: NOW, nonce: NONCE });
    expect(r.queryAppend).toEqual({ name: "sig", value: expect.any(String) });
    expect(Object.keys(r.headers)).not.toContain("sig");
    // hmac-sha256 over "GET&/x"
    const expected = createHmac("sha256", "k").update("GET&/x", "utf8").digest("base64");
    expect(r.queryAppend!.value).toBe(expected);
  });

  it("throws when a header references an unresolved vault secret", () => {
    const cfg: SignedAuthConfig = {
      type: "signed", algorithm: "hmac-sha1", secret: "S",
      headers: { "x-key": "{vault:MISSING}" },
      canonical: [{ kind: "path" }],
      signature: { in: "header", name: "x-sig" },
    };
    expect(() => signRequest({ config: cfg, keyMaterial: "k", vault: {}, method: "GET", path: "/x", query: "", host: "h", now: NOW, nonce: NONCE })).toThrow(/unresolved vault secret/);
  });
});

describe("validateSignedAuth", () => {
  it("accepts the Webull config", () => {
    expect(validateSignedAuth(webullConfig as unknown as Record<string, unknown>)).toBeNull();
  });
  it("rejects a missing secret", () => {
    expect(validateSignedAuth({ algorithm: "hmac-sha1", canonical: [{ kind: "path" }], signature: { in: "header", name: "x" } }))
      .toMatch(/secret/);
  });
  it("rejects an unknown algorithm", () => {
    expect(validateSignedAuth({ algorithm: "md5", secret: "S", canonical: [{ kind: "path" }], signature: { in: "header", name: "x" } }))
      .toMatch(/algorithm/);
  });
  it("rejects an empty canonical", () => {
    expect(validateSignedAuth({ algorithm: "hmac-sha1", secret: "S", canonical: [], signature: { in: "header", name: "x" } }))
      .toMatch(/canonical/);
  });
  it("rejects a bad signature placement", () => {
    expect(validateSignedAuth({ algorithm: "hmac-sha1", secret: "S", canonical: [{ kind: "path" }], signature: { in: "cookie", name: "x" } }))
      .toMatch(/signature\.in/);
  });
});
