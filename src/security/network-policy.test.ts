import { describe, it, expect } from "vitest";
import { resolveAndPinHost, validateUrlWithDns } from "./network-policy.js";

const EMPTY_ALLOWLIST = new Set<string>();

describe("resolveAndPinHost", () => {
  it("returns { ok: true, pin: null } for a literal IPv4 (nothing to resolve)", async () => {
    const result = await resolveAndPinHost("127.0.0.1");
    expect(result).toEqual({ ok: true, pin: null });
  });

  it("returns { ok: true, pin: null } for a literal IPv6 (nothing to resolve)", async () => {
    const result = await resolveAndPinHost("::1");
    expect(result).toEqual({ ok: true, pin: null });
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
