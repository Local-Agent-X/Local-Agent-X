// config tests — the broker is the only phone↔desktop transport now, so
// transportMode is constant and loadBrokerConfig resolves on dial creds alone
// (no LAX_TRANSPORT gate), still failing SAFE on a partial dial config.

import { describe, it, expect } from "vitest";
import { transportMode, loadBrokerConfig } from "./config.js";

const FULL = {
  LAX_DEVICE_ID: "desk-1",
  LAX_PAIRED_PHONE_ID: "phone-1",
  LAX_BROKER_TOKEN: "tok",
} as NodeJS.ProcessEnv;

describe("transportMode", () => {
  it("is always 'broker' (the tailnet bridge is gone)", () => {
    expect(transportMode({} as NodeJS.ProcessEnv)).toBe("broker");
    expect(transportMode({ LAX_TRANSPORT: "anything" } as NodeJS.ProcessEnv)).toBe("broker");
  });
});

describe("loadBrokerConfig", () => {
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
