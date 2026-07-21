import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  telegramApiCall: vi.fn(),
  telegramDispatchReply: vi.fn(),
  whatsappDispatchReply: vi.fn(),
  resolveLiveBridgeOps: vi.fn(),
  cancelBridgeOps: vi.fn(),
}));

vi.mock("../src/telegram-bridge/api.js", () => ({
  apiCall: fakes.telegramApiCall,
  sendMessage: vi.fn(),
  sendVoice: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
}));
vi.mock("../src/telegram-bridge/inbound.js", () => ({
  describeNonTextMessage: vi.fn(),
  dispatchReply: fakes.telegramDispatchReply,
  transcribeInboundVoice: vi.fn(),
}));
vi.mock("../src/bridge-voice/index.js", () => ({}));
vi.mock("../src/voice/index.js", () => ({}));
vi.mock("../src/whatsapp-bridge/voice-reply.js", () => ({
  markVoiceMirror: vi.fn(),
  clearVoiceMirror: vi.fn(),
  dispatchReplyToJid: fakes.whatsappDispatchReply,
}));
vi.mock("../src/bridge-control.js", () => ({
  applyBridgeInjection: vi.fn(),
  resolveLiveBridgeOps: fakes.resolveLiveBridgeOps,
  cancelBridgeOps: fakes.cancelBridgeOps,
}));

import { TelegramBridge } from "../src/telegram-bridge/bridge.js";
import { createMessagesUpsertHandler } from "../src/whatsapp-bridge/message-handler.js";

async function runTelegram(text: string, onMessage: ReturnType<typeof vi.fn>): Promise<void> {
  const bridge = new TelegramBridge({
    dataDir: "/nonexistent-channel-parity-telegram", getToken: () => "TESTTOKEN", onMessage,
  }) as any;
  bridge.state = "connected";
  bridge.allowedChatIds = new Set(["42"]);
  bridge.ownerVerified = true;
  bridge.processingLock.add("42");
  await bridge.handleUpdate({
    update_id: 1001,
    message: { chat: { id: 42 }, from: { first_name: "Peter" }, text },
  }, "TESTTOKEN");
}

async function runWhatsApp(text: string, onMessage: ReturnType<typeof vi.fn>): Promise<void> {
  const handler = createMessagesUpsertHandler({
    phoneNumber: "15550001", selfLid: "owner", allowedNumbers: new Set(), processedMessages: new Set(),
    processingLock: new Set(["15550001"]),
    sock: { readMessages: vi.fn(), sendPresenceUpdate: vi.fn().mockResolvedValue(undefined) },
    onMessage, sendMessage: vi.fn().mockResolvedValue(true), sendToJid: vi.fn().mockResolvedValue(true),
    sendVoiceToJid: vi.fn().mockResolvedValue(true),
  }, null);
  await handler({ type: "notify", messages: [{
    key: { id: "PARITY1", remoteJid: "owner@lid", fromMe: true }, pushName: "Peter",
    message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000),
  }] });
}

describe("Telegram and WhatsApp inbound control parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.telegramApiCall.mockResolvedValue({ ok: true });
    fakes.telegramDispatchReply.mockResolvedValue(true);
    fakes.whatsappDispatchReply.mockResolvedValue(true);
    fakes.resolveLiveBridgeOps.mockResolvedValue(["op-running"]);
    fakes.cancelBridgeOps.mockResolvedValue(undefined);
  });

  it.each([
    ["/st\u200Bop", "/stop"], ["/ca\u202Encel", "/cancel"],
    ["/st\u2028op", "/stop"], ["/ca\u2029ncel", "/cancel"],
    ["/st\u202Fop", "/stop"], ["/st\u200Cop", "/stop"],
  ])("normalizes exact hidden-format control %s at both transport boundaries", async (text, command) => {
    const telegramMessage = vi.fn().mockResolvedValue(null);
    const whatsappMessage = vi.fn().mockResolvedValue(null);

    await runTelegram(text, telegramMessage);
    await runWhatsApp(text, whatsappMessage);

    for (const call of [telegramMessage.mock.calls[0][0], whatsappMessage.mock.calls[0][0]]) {
      expect(call.text).toBe(command);
      expect(call).not.toHaveProperty("intent");
      expect(call.deliveryId).toMatch(/^(update|message):/);
      expect(call.deliveryTarget).toBeTruthy();
    }
  });

  it("preserves legitimate Unicode and ordinary active-turn steering on both transports", async () => {
    const text = "line one\u2028line two\u2029paragraph\u202Fspace\u200Cjoin\u200Dword\u2060join";
    const telegramMessage = vi.fn().mockResolvedValue(null);
    const whatsappMessage = vi.fn().mockResolvedValue(null);

    await runTelegram(text, telegramMessage);
    await runWhatsApp(text, whatsappMessage);

    expect(telegramMessage).toHaveBeenCalledWith(expect.objectContaining({ text, intent: "steer" }));
    expect(whatsappMessage).toHaveBeenCalledWith(expect.objectContaining({ text, intent: "steer" }));
  });

  it("reaches the canonical stop control from both active transport adapters", async () => {
    const { createBridgeHandler } = await import("../src/server/bootstrap-bridges.js");
    const handler = createBridgeHandler({
      sessions: new Map(), sessionStore: { delete: vi.fn() } as never, config: {} as never,
      getContext: vi.fn() as never,
    });
    const telegramMessage = vi.fn((payload) => handler("telegram", { ...payload, deliveryId: undefined }));
    const whatsappMessage = vi.fn((payload) => handler("whatsapp", { ...payload, deliveryId: undefined }));

    await runTelegram("/st\u2028op", telegramMessage);
    await runWhatsApp("/ca\u200Dncel", whatsappMessage);

    expect(fakes.cancelBridgeOps.mock.calls).toEqual([
      [["op-running"], "telegram-stop"],
      [["op-running"], "whatsapp-stop"],
    ]);
  });
});
