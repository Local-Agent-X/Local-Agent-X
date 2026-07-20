import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMessagingSessionId,
  getMessagingBridge,
  getMessagingChannelDefinition,
  messagingChannelAuthPath,
  messagingChannelAuthReadyPath,
  messagingChannelConfigPath,
  parseMessagingSessionTarget,
} from "./channel-registry.js";
import {
  getTelegramBridgeInstance,
  setTelegramBridgeInstance,
  type TelegramBridge,
} from "../telegram-bridge/index.js";
import {
  getWhatsAppBridgeInstance,
  setWhatsAppBridgeInstance,
  type WhatsAppBridge,
} from "../whatsapp-bridge/index.js";

afterEach(() => {
  setTelegramBridgeInstance(null);
  setWhatsAppBridgeInstance(null);
});

describe("messaging channel registry", () => {
  it("owns the persisted identity metadata for both existing channels", () => {
    expect(getMessagingChannelDefinition("telegram")).toEqual({
      id: "telegram",
      displayName: "Telegram",
      sessionPrefix: "tg-",
      configFile: "telegram-config.json",
      tokenSecret: "TELEGRAM_BOT_TOKEN",
      authDirectory: null,
      authReadyFile: null,
      supportsQrPairing: false,
    });
    expect(getMessagingChannelDefinition("whatsapp")).toEqual({
      id: "whatsapp",
      displayName: "WhatsApp",
      sessionPrefix: "wa-",
      configFile: "whatsapp-config.json",
      tokenSecret: null,
      authDirectory: "whatsapp-auth",
      authReadyFile: "creds.json",
      supportsQrPairing: true,
    });
  });

  it("keeps current config, token, QR-session, and restart identities stable", () => {
    const dataDir = join("root", "lax-data");
    expect(messagingChannelConfigPath(dataDir, "telegram")).toBe(join(dataDir, "telegram-config.json"));
    expect(messagingChannelConfigPath(dataDir, "whatsapp")).toBe(join(dataDir, "whatsapp-config.json"));
    expect(messagingChannelAuthPath(dataDir, "telegram")).toBeNull();
    expect(messagingChannelAuthPath(dataDir, "whatsapp")).toBe(join(dataDir, "whatsapp-auth"));
    expect(messagingChannelAuthReadyPath(dataDir, "telegram")).toBeNull();
    expect(messagingChannelAuthReadyPath(dataDir, "whatsapp")).toBe(join(dataDir, "whatsapp-auth", "creds.json"));
    expect(parseMessagingSessionTarget("tg-8199987986")).toEqual({ channel: "telegram", target: "8199987986" });
    expect(parseMessagingSessionTarget("wa-15551234567")).toEqual({ channel: "whatsapp", target: "15551234567" });
    expect(parseMessagingSessionTarget("chat-web-abc")).toBeNull();
    expect(buildMessagingSessionId("telegram", "8199987986")).toBe("tg-8199987986");
    expect(buildMessagingSessionId("whatsapp", "15551234567")).toBe("wa-15551234567");
  });

  it("keeps legacy bridge APIs and hot replacement on the same live identity", () => {
    const telegramA = { identity: "telegram-a" } as unknown as TelegramBridge;
    const telegramB = { identity: "telegram-b" } as unknown as TelegramBridge;
    const whatsappA = { identity: "whatsapp-a" } as unknown as WhatsAppBridge;

    setTelegramBridgeInstance(telegramA);
    setWhatsAppBridgeInstance(whatsappA);
    expect(getTelegramBridgeInstance()).toBe(telegramA);
    expect(getMessagingBridge("telegram")).toBe(telegramA);
    expect(getWhatsAppBridgeInstance()).toBe(whatsappA);
    expect(getMessagingBridge("whatsapp")).toBe(whatsappA);

    setTelegramBridgeInstance(telegramB);
    expect(getTelegramBridgeInstance()).toBe(telegramB);
    expect(getMessagingBridge("telegram")).toBe(telegramB);
    expect(getMessagingBridge("whatsapp")).toBe(whatsappA);
  });
});
