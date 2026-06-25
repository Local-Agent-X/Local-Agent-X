// config tests — the kill-switch must fail SAFE: anything short of an explicit
// LAX_TRANSPORT=broker plus a complete dial config resolves to the tailnet path.

import { describe, it, expect } from "vitest";
import { transportMode, loadBrokerConfig } from "./config.js";

const FULL = {
  LAX_TRANSPORT: "broker",
  LAX_DEVICE_ID: "desk-1",
  LAX_PAIRED_PHONE_ID: "phone-1",
  LAX_BROKER_TOKEN: "tok",
} as NodeJS.ProcessEnv;

describe("transportMode", () => {
  it("defaults to tailnet when unset", () => {
    expect(transportMode({} as NodeJS.ProcessEnv)).toBe("tailnet");
  });
  it("only the exact string 'broker' selects the broker path", () => {
    expect(transportMode({ LAX_TRANSPORT: "broker" } as NodeJS.ProcessEnv)).toBe("broker");
    expect(transportMode({ LAX_TRANSPORT: "Broker" } as NodeJS.ProcessEnv)).toBe("tailnet");
    expect(transportMode({ LAX_TRANSPORT: "1" } as NodeJS.ProcessEnv)).toBe("tailnet");
  });
});

describe("loadBrokerConfig", () => {
  it("returns null when the flag is off (even with full creds)", () => {
    expect(loadBrokerConfig({ ...FULL, LAX_TRANSPORT: "tailnet" })).toBeNull();
  });

  it("returns null when any dial parameter is missing (no partial activation)", () => {
    expect(loadBrokerConfig({ ...FULL, LAX_DEVICE_ID: undefined })).toBeNull();
    expect(loadBrokerConfig({ ...FULL, LAX_PAIRED_PHONE_ID: undefined })).toBeNull();
    expect(loadBrokerConfig({ ...FULL, LAX_BROKER_TOKEN: undefined })).toBeNull();
  });

  it("resolves a complete config, defaulting the broker URL", () => {
    expect(loadBrokerConfig(FULL)).toEqual({
      brokerWsUrl: "wss://broker.agentxos.ai",
      deviceId: "desk-1",
      pairedPhoneId: "phone-1",
      token: "tok",
    });
  });

  it("honors an explicit LAX_BROKER_URL override", () => {
    expect(loadBrokerConfig({ ...FULL, LAX_BROKER_URL: "ws://localhost:8787" })?.brokerWsUrl).toBe(
      "ws://localhost:8787",
    );
  });
});
