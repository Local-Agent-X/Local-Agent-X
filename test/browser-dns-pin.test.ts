import { describe, it, expect, vi, beforeEach } from "vitest";

// dnsPinCheck resolves A/AAAA records via node:dns promises. Mock both so the
// tests are deterministic and offline; each case primes the resolver returns.
const resolve4 = vi.fn<(host: string) => Promise<string[]>>();
const resolve6 = vi.fn<(host: string) => Promise<string[]>>();

vi.mock("node:dns", () => ({
  promises: {
    resolve4: (host: string) => resolve4(host),
    resolve6: (host: string) => resolve6(host),
  },
}));

import { dnsPinCheck } from "../src/browser/guards.js";

beforeEach(() => {
  resolve4.mockReset();
  resolve6.mockReset();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
});

describe("dnsPinCheck — IPv6 / DNS-rebinding hardening", () => {
  it("treats literal ::1 (loopback) as safe — same class as localhost", async () => {
    // ::1 is IPv6 loopback. The explicit [::1] early-return keeps it allowed,
    // matching the 127.0.0.1/localhost policy. isPrivateIpv6 also classifies
    // bare ::1 — so any code path agrees it is not an external rebind target.
    expect(await dnsPinCheck("http://[::1]/")).toBeNull();
  });

  it("treats bracketed [::1] with a port as safe", async () => {
    expect(await dnsPinCheck("http://[::1]:8080/")).toBeNull();
  });

  it("blocks literal fe80::1 (link-local)", async () => {
    expect(await dnsPinCheck("http://[fe80::1]/")).toMatch(/private\/reserved IP/);
  });

  it("blocks literal fc00::1 (ULA)", async () => {
    expect(await dnsPinCheck("http://[fc00::1]/")).toMatch(/private\/reserved IP/);
  });

  it("blocks literal fd12::1 (ULA)", async () => {
    expect(await dnsPinCheck("http://[fd12::1]/")).toMatch(/private\/reserved IP/);
  });

  it("blocks IPv4-mapped ::ffff:192.168.1.1", async () => {
    expect(await dnsPinCheck("http://[::ffff:192.168.1.1]/")).toMatch(/private\/reserved IP/);
  });

  it("allows public IPv6 literal 2606:4700:4700::1111", async () => {
    expect(await dnsPinCheck("http://[2606:4700:4700::1111]/")).toBeNull();
  });

  it("blocks a hostname whose AAAA record is a ULA address", async () => {
    resolve6.mockResolvedValue(["fd00::dead:beef"]);
    expect(await dnsPinCheck("https://evil.example.com/")).toMatch(/DNS rebinding blocked/);
  });

  it("blocks a hostname whose A record is 10.x (regression)", async () => {
    resolve4.mockResolvedValue(["10.0.0.5"]);
    expect(await dnsPinCheck("https://evil.example.com/")).toMatch(/DNS rebinding blocked/);
  });

  it("allows a hostname resolving only to public addresses", async () => {
    resolve4.mockResolvedValue(["93.184.216.34"]);
    resolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);
    expect(await dnsPinCheck("https://example.com/")).toBeNull();
  });

  it("allows localhost", async () => {
    expect(await dnsPinCheck("http://localhost:3000/")).toBeNull();
  });

  it("allows 127.0.0.1 literal", async () => {
    expect(await dnsPinCheck("http://127.0.0.1/")).toBeNull();
  });
});
