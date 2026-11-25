import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localNetworkDecision } from "./local-network-grant.js";
import { isLanAddress, isLocalNetworkName } from "./ip-classification.js";
import { _setInterfaceAddressesForTests } from "./loopback-grant.js";

describe("isLanAddress", () => {
  it("holds the ranges a device on a local network lives in", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1", "100.64.0.1", "169.254.169.254", "fd00::1", "fe80::1"]) {
      expect(isLanAddress(ip), ip).toBe(true);
    }
  });

  it("never loopback, reserved, public, encoded or mapped", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "224.0.0.1", "8.8.8.8", "172.32.0.1", "010.0.0.1", "0xa000001", "::1", "::ffff:192.168.1.1", "2606:4700::1", "router.lan"]) {
      expect(isLanAddress(ip), ip).toBe(false);
    }
  });
});

describe("isLocalNetworkName", () => {
  it("names under a private-use suffix, and nothing public", () => {
    for (const h of ["router.home.internal", "nas.local", "printer.lan", "hub.home.arpa"]) expect(isLocalNetworkName(h), h).toBe(true);
    for (const h of ["example.com", "local.example.com", "internal.example.org", "lan.party.io"]) expect(isLocalNetworkName(h), h).toBe(false);
  });
});

describe("localNetworkDecision", () => {
  beforeEach(() => _setInterfaceAddressesForTests(() => ["127.0.0.1", "::1", "10.0.0.9"]));
  afterEach(() => _setInterfaceAddressesForTests(null));

  it("is no decision for a public host or this machine", () => {
    expect(localNetworkDecision("example.com", new Set())).toBeNull();
    expect(localNetworkDecision("10.0.0.9", new Set(["10.0.0.9"]))).toBeNull();
    expect(localNetworkDecision("127.0.0.1", new Set())).toBeNull();
  });

  it("refuses with the allow-host action, and allows once the device is on the list", () => {
    expect(localNetworkDecision("192.168.1.1", new Set())).toMatchObject({ allowed: false, action: { kind: "allow-host", host: "192.168.1.1" } });
    expect(localNetworkDecision("192.168.1.1", new Set(["192.168.1.1"]))).toMatchObject({ allowed: true });
    expect(localNetworkDecision("nas.local", new Set(["*.local"]))).toMatchObject({ allowed: false });
    expect(localNetworkDecision("nas.home.internal", new Set(["*.home.internal"]))).toMatchObject({ allowed: true });
  });
});
