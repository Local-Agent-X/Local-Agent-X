// What counts as loopback is defined once, here. Two answers on purpose:
// isLoopbackAddress is every loopback literal ("does this stay on this
// machine"), loopbackPinFor is where an alias NAME is dialed so no resolver
// gets to answer for it.
import { describe, expect, it } from "vitest";
import { canonicalizeHost, isLoopbackAddress, isLoopbackHost, LOOPBACK_HOSTNAMES, loopbackPinFor } from "./ip-classification.js";

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.1.2.3", "127.255.255.255", "::1", "::ffff:127.0.0.1"])("is true for %s", (host) => {
    expect(isLoopbackAddress(host)).toBe(true);
  });

  it.each([
    "126.0.0.1", "128.0.0.1", "127.0.0.256", "127.0.0", "0.0.0.0", "10.0.0.1",
    "::", "::ffff:7f00:1", "::ffff:8.8.8.8", "localhost", "ip6-localhost", "127.0.0.1.example.com", "",
  ])("is false for %s", (host) => {
    expect(isLoopbackAddress(host)).toBe(false);
  });

  it("is false for a client address the socket did not report", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("reads a URL's host once it is canonicalized", () => {
    expect(isLoopbackAddress(canonicalizeHost(new URL("http://[::1]:11434/").hostname))).toBe(true);
    expect(isLoopbackAddress(canonicalizeHost(new URL("http://127.0.0.1./").hostname))).toBe(true);
  });
});

describe("loopbackPinFor", () => {
  it("pins every loopback alias name to a loopback literal of its own family", () => {
    for (const name of LOOPBACK_HOSTNAMES) {
      const pin = loopbackPinFor(name);
      expect(pin, name).not.toBeNull();
      expect(isLoopbackAddress(pin!.address), name).toBe(true);
      expect(pin!.family, name).toBe(name.startsWith("ip6-") ? 6 : 4);
    }
    expect(loopbackPinFor("localhost")).toEqual({ address: "127.0.0.1", family: 4 });
    expect(loopbackPinFor("ip6-localhost")).toEqual({ address: "::1", family: 6 });
  });

  it("pins nothing else: a literal dials as itself and any other name is resolved and checked", () => {
    for (const host of ["127.0.0.1", "::1", "example.com", "localhost.example.com", "mylocalhost", ""]) {
      expect(loopbackPinFor(host), host).toBeNull();
    }
  });

  it("covers every name the port carve-outs treat as loopback", () => {
    for (const name of LOOPBACK_HOSTNAMES) expect(isLoopbackHost(name), name).toBe(true);
  });
});
