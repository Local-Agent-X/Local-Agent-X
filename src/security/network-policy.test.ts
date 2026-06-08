import { describe, it, expect } from "vitest";
import { resolveAndPinHost, validateUrlWithDns } from "./network-policy.js";

const EMPTY_ALLOWLIST = new Set<string>();

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
