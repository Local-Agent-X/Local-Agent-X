import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as dns } from "node:dns";
import { resolveAndPinHost } from "./network-dns.js";

// The egress resolver decides what every proxied and http_request dial may
// reach. It resolves through the OS resolver (getaddrinfo), under a deadline,
// and fails closed on anything but a clean public answer. These pin the
// contract at the module, independent of the callers' suites.
describe("resolveAndPinHost", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("resolves through dns.lookup with every address, and pins IPv4 first", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "2606:4700::1", family: 6 },
      { address: "104.20.23.154", family: 4 },
    ] as never);
    const r = await resolveAndPinHost("example.com");
    expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
    expect(r).toEqual({ ok: true, pin: { address: "104.20.23.154", family: 4 } });
  });

  it("pins IPv6 when that is all there is", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "2606:4700::1", family: 6 }] as never);
    expect(await resolveAndPinHost("v6only.example")).toEqual({ ok: true, pin: { address: "2606:4700::1", family: 6 } });
  });

  it("blocks when ANY answer is private, whichever family (rebinding)", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "104.20.23.154", family: 4 },
      { address: "fd00::1", family: 6 },
    ] as never);
    const r = await resolveAndPinHost("evil.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private IPv6 fd00::1 \(DNS rebinding protection\)/);
  });

  it("fails closed with the resolver's own error code when the lookup rejects", async () => {
    vi.spyOn(dns, "lookup").mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const r = await resolveAndPinHost("nonexistent.invalid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Blocked: DNS resolution failed for nonexistent.invalid (ENOTFOUND; fail-closed SSRF protection)");
  });

  it("fails closed on an empty answer", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([] as never);
    const r = await resolveAndPinHost("empty.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("DNS resolution failed for empty.example");
  });

  it("a resolver that never answers is refused at the deadline, not left hanging", async () => {
    vi.useFakeTimers();
    vi.spyOn(dns, "lookup").mockReturnValue(new Promise(() => {}) as never);
    const pending = resolveAndPinHost("hung.example");
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ETIMEOUT");
  });

  it("does not resolve a literal IP at all — public passes, private is blocked", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    expect(await resolveAndPinHost("93.184.216.34")).toEqual({ ok: true, pin: null });
    expect((await resolveAndPinHost("169.254.169.254")).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
