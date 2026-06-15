import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { TelegramBridge } from "../src/telegram-bridge/index.js";
import { setTelegramBridgeInstance } from "../src/telegram-bridge/index.js";
import { telegramSend } from "../src/tools/telegram-tools.js";
import { formatForChannel } from "../src/channel-formatter.js";

// Seam: telegram_send (tool) → TelegramBridge (transport). The registration of
// the tool across the registry / ARI class map / action map / policy is guarded
// by the coverage + orphan tests; this guards the tool's own boundary logic —
// most importantly that a proactive send is CONFINED to authorized chats so an
// injected chat_id can't redirect the message to an attacker.

type Sent = { chatId: string; text: string };

function stubBridge(over: Partial<{ state: string; allowedChatIds: string[]; sendOk: boolean }>): { bridge: TelegramBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const state = over.state ?? "connected";
  const allowedChatIds = over.allowedChatIds ?? ["123"];
  const sendOk = over.sendOk ?? true;
  const bridge = {
    getStatus: () => ({ state, botUsername: "bot", botName: "Bot", error: null, allowedChatIds }),
    sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); return sendOk; },
  } as unknown as TelegramBridge;
  return { bridge, sent };
}

describe("telegram_send — boundary + confinement", () => {
  beforeEach(() => setTelegramBridgeInstance(null));
  afterEach(() => setTelegramBridgeInstance(null));

  it("errors when the bridge is not configured", async () => {
    const r = await telegramSend.execute({ text: "hi alpha" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not set up|configured/i);
  });

  it("errors on empty text (before touching the bridge)", async () => {
    const { bridge, sent } = stubBridge({});
    setTelegramBridgeInstance(bridge);
    const r = await telegramSend.execute({ text: "   " });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("errors when the bridge is not connected", async () => {
    const { bridge } = stubBridge({ state: "error" });
    setTelegramBridgeInstance(bridge);
    const r = await telegramSend.execute({ text: "hi bravo" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not connected/i);
  });

  it("errors when no owner chat is authorized", async () => {
    const { bridge } = stubBridge({ allowedChatIds: [] });
    setTelegramBridgeInstance(bridge);
    const r = await telegramSend.execute({ text: "hi charlie" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no authorized/i);
  });

  it("sends to the owner chat by default, MarkdownV2-formatted", async () => {
    const { bridge, sent } = stubBridge({ allowedChatIds: ["123"] });
    setTelegramBridgeInstance(bridge);
    const text = "Did you work out today? Don't slack!";
    const r = await telegramSend.execute({ text });
    expect(r.isError).toBeFalsy();
    expect(sent).toEqual([{ chatId: "123", text: formatForChannel(text, "telegram").join("\n\n") }]);
  });

  it("REFUSES an unauthorized chat_id and does not send (confinement)", async () => {
    const { bridge, sent } = stubBridge({ allowedChatIds: ["123"] });
    setTelegramBridgeInstance(bridge);
    const r = await telegramSend.execute({ text: "hi delta", chat_id: "999" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not an authorized chat/i);
    expect(sent).toHaveLength(0);
  });

  it("allows an explicitly-authorized chat_id", async () => {
    const { bridge, sent } = stubBridge({ allowedChatIds: ["123", "456"] });
    setTelegramBridgeInstance(bridge);
    const r = await telegramSend.execute({ text: "hi echo", chat_id: "456" });
    expect(r.isError).toBeFalsy();
    expect(sent.map((s) => s.chatId)).toEqual(["456"]);
  });
});
