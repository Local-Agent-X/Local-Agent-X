import { describe, it, expect } from "vitest";
import { resolveAndPinHost, validateUrlWithDns, evaluateWebFetch } from "./network-policy.js";

const EMPTY_ALLOWLIST = new Set<string>();

/** Run the synchronous web-fetch policy in permissive mode (no disk access). */
function webFetch(url: string) {
  return evaluateWebFetch(EMPTY_ALLOWLIST, false, "7007", url, "permissive");
}

describe("resolveAndPinHost", () => {
  it("returns { ok: true, pin: null } for a PUBLIC literal IPv4 (nothing to resolve)", async () => {
    const result = await resolveAndPinHost("93.184.216.34");
    expect(result).toEqual({ ok: true, pin: null });
  });

  // SSRF-via-redirect (finding H5): a 302 to a literal private/metadata IP must
  // be blocked HERE, because this guard is the chokepoint every redirect hop
  // passes through (evaluateWebFetch only validates the original URL).
  it.each([
    ["169.254.169.254"], // cloud metadata (link-local)
    ["127.0.0.1"],       // loopback
    ["10.0.0.5"],        // RFC1918 private
    ["192.168.1.1"],     // RFC1918 private
  ])("blocks literal private/metadata IPv4 %s", async (ip) => {
    const result = await resolveAndPinHost(ip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("blocks a literal IPv6 loopback [::1]", async () => {
    const result = await resolveAndPinHost("[::1]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("blocks an IPv4-mapped IPv6 literal for the metadata IP (::ffff:169.254.169.254)", async () => {
    const result = await resolveAndPinHost("::ffff:169.254.169.254");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  // 'localhost' must never pin to a usable address: depending on the resolver,
  // it either resolves to loopback (rebinding block) or has no A/AAAA records
  // (fail-closed). Both are ok: false — the only acceptable outcome.
  it("blocks 'localhost' (loopback rebinding or fail-closed, never pinned)", async () => {
    const result = await resolveAndPinHost("localhost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.reason.includes("DNS rebinding protection") ||
          result.reason.includes("fail-closed SSRF protection"),
      ).toBe(true);
    }
  });

  it("fails closed for a host that never resolves (.invalid TLD)", async () => {
    const result = await resolveAndPinHost("nonexistent-host-xyz.invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("fail-closed SSRF protection");
    }
  });
});

// Round-3 finding C3-5: NAT64 (64:ff9b::/96, RFC6052) and 6to4 (2002::/16,
// RFC3056) IPv6 literals embed an IPv4 address. A literal like
// 64:ff9b::169.254.169.254 or 2002:a9fe:a9fe:: dials the embedded IPv4 (here,
// cloud metadata) while looking like a benign public IPv6 host. isPrivateIPv6
// must decode the embedded v4 and range-check it. Only a private/reserved
// embedding is blocked — a transition literal wrapping a PUBLIC IPv4 still
// connects (no over-block of legitimate transition addressing).
describe("evaluateWebFetch — NAT64/6to4 embedded-IPv4 SSRF (C3-5)", () => {
  it.each([
    ["[64:ff9b::169.254.169.254]", "NAT64 dotted-tail → AWS metadata"],
    ["[64:ff9b::a9fe:a9fe]", "NAT64 hex-tail → AWS metadata (same address)"],
    ["[64:ff9b:1::169.254.169.254]", "NAT64 local-use prefix → metadata"],
    ["[2002:a9fe:a9fe::]", "6to4 → 169.254.169.254 metadata"],
    ["[2002:0a00:0001::]", "6to4 → 10.0.0.1 RFC1918 private"],
    ["[2002:7f00:0001::]", "6to4 → 127.0.0.1 loopback"],
  ])("blocks %s (%s)", (host) => {
    const d = webFetch(`http://${host}/`);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("private/reserved IPv6");
  });

  it.each([
    ["[2606:4700:4700::1111]", "Cloudflare public IPv6 — not a transition literal"],
    ["[2002:0808:0808::]", "6to4 wrapping PUBLIC 8.8.8.8 — only private embeds blocked"],
    ["[64:ff9b::8.8.8.8]", "NAT64 wrapping PUBLIC 8.8.8.8"],
  ])("allows %s (%s)", (host) => {
    const d = webFetch(`http://${host}/`);
    expect(d.allowed).toBe(true);
  });

  // The dispatcher path (resolveAndPinHost) shares isPrivateIPv6, so the same
  // literals are blocked there too — closing the redirect-hop SSRF (C3-23).
  it("resolveAndPinHost blocks a NAT64 metadata literal", async () => {
    const result = await resolveAndPinHost("64:ff9b::169.254.169.254");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SSRF protection");
  });

  it("resolveAndPinHost allows a 6to4 literal wrapping a public IPv4", async () => {
    const result = await resolveAndPinHost("2002:0808:0808::");
    expect(result).toEqual({ ok: true, pin: null });
  });
});

describe("validateUrlWithDns — literal-IP regression", () => {
  it("allows a self-call to the agent's own server (literal IPv4 path)", async () => {
    const selfPort = "7007";
    const decision = await validateUrlWithDns(
      EMPTY_ALLOWLIST,
      false,
      selfPort,
      `http://127.0.0.1:${selfPort}/x`,
      "permissive",
    );
    expect(decision.allowed).toBe(true);
  });

  it("still blocks a private literal IPv4 (10.0.0.0/8)", async () => {
    const decision = await validateUrlWithDns(
      EMPTY_ALLOWLIST,
      false,
      "7007",
      "http://10.0.0.1/",
      "permissive",
    );
    expect(decision.allowed).toBe(false);
  });
});
