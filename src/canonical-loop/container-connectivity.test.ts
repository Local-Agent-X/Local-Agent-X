import { afterEach, describe, expect, it } from "vitest";
import {
  assertCurrentContainerConnectivity,
  captureContainerConnectivity,
  validatedHostGateway,
} from "./container-connectivity.js";

const original = {
  gateway: process.env.LAX_CONTAINER_HOST_GATEWAY,
  network: process.env.LAX_CONTAINER_EXECUTION_NETWORK,
  networkId: process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID,
  networkGateway: process.env.LAX_CONTAINER_EXECUTION_NETWORK_GATEWAY,
};

afterEach(() => {
  restore("LAX_CONTAINER_HOST_GATEWAY", original.gateway);
  restore("LAX_CONTAINER_EXECUTION_NETWORK", original.network);
  restore("LAX_CONTAINER_EXECUTION_NETWORK_ID", original.networkId);
  restore("LAX_CONTAINER_EXECUTION_NETWORK_GATEWAY", original.networkGateway);
});

describe("container connectivity identity", () => {
  it("rejects a remote hostname as a host gateway", () => {
    process.env.LAX_CONTAINER_HOST_GATEWAY = "evil.example.com";
    expect(() => validatedHostGateway()).toThrow("inspected network gateway");
  });

  it("accepts only a literal that can be bound to inspected network IPAM", () => {
    process.env.LAX_CONTAINER_HOST_GATEWAY = "172.18.0.1";
    expect(validatedHostGateway()).toBe("172.18.0.1");
    process.env.LAX_CONTAINER_HOST_GATEWAY = "host.docker.internal";
    expect(() => validatedHostGateway()).toThrow("inspected network gateway");
  });

  it("fails recovery when the sealed gateway or network changes", () => {
    process.env.LAX_CONTAINER_HOST_GATEWAY = "172.18.0.1";
    process.env.LAX_CONTAINER_EXECUTION_NETWORK = "lax-egress";
    process.env.LAX_CONTAINER_EXECUTION_NETWORK_ID = "a".repeat(64);
    process.env.LAX_CONTAINER_EXECUTION_NETWORK_GATEWAY = "172.18.0.1";
    const captured = captureContainerConnectivity(true);
    process.env.LAX_CONTAINER_HOST_GATEWAY = "172.18.0.2";
    expect(() => assertCurrentContainerConnectivity(captured)).toThrow("identity changed");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
