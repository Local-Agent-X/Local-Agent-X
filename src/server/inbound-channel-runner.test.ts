import { beforeEach, describe, expect, it, vi } from "vitest";

const runChatTurn = vi.fn();
const forwardBridgeMedia = vi.fn();
const claimInboundDelivery = vi.fn();
const bindInboundOperation = vi.fn();
const completeInboundDelivery = vi.fn();

vi.mock("../routes/chat/run-chat-turn.js", () => ({ runChatTurn }));
vi.mock("./bridge-media-forward.js", () => ({ forwardBridgeMedia }));
vi.mock("./inbound-delivery-store.js", () => ({
  claimInboundDelivery, bindInboundOperation, completeInboundDelivery,
}));

const { createInboundChannelRunner } = await import("./inbound-channel-runner.js");

const context = {
  whatsappBridge: { kind: "wa" },
  telegramBridge: { kind: "tg" },
} as never;

describe("canonical inbound channel runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimInboundDelivery.mockReturnValue({ acquired: true, claim: { receiptId: "receipt", generation: 1 } });
    bindInboundOperation.mockReturnValue(true);
    completeInboundDelivery.mockReturnValue(true);
    runChatTurn.mockImplementation(async ({ sseSink }) => {
      sseSink({ type: "chat_op_started", opId: "op-1" });
      sseSink({ type: "stream", delta: "hello " });
      sseSink({ type: "stream", delta: "there" });
      sseSink({ type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    });
  });

  it.each(["telegram", "whatsapp"] as const)("routes %s through runChatTurn with channel parity", async (channel) => {
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run(channel, {
      from: "42", name: "Peter", text: "do it", sessionId: channel === "telegram" ? "tg-42" : "wa-42",
      deliveryId: "delivery-1",
    });
    expect(runChatTurn).toHaveBeenCalledTimes(1);
    expect(runChatTurn.mock.calls[0][0]).toMatchObject({
      channel,
      message: "do it",
      requestRole: "operator",
      skipMemory: true,
      maxHistory: 30,
    });
    expect(runChatTurn.mock.calls[0][0].bridgeContext).toContain(channel === "telegram" ? "Telegram bridge" : "WhatsApp bridge");
    expect(reply?.speakable).toBe("hello there");
    expect(bindInboundOperation).toHaveBeenCalledWith({ receiptId: "receipt", generation: 1 }, "op-1");
    expect(completeInboundDelivery).toHaveBeenCalledTimes(1);
    expect(forwardBridgeMedia).toHaveBeenCalledWith(expect.objectContaining({ canonicalOpId: "op-1", channelType: channel }));
    expect(forwardBridgeMedia.mock.invocationCallOrder[0]).toBeLessThan(completeInboundDelivery.mock.invocationCallOrder[0]);
  });

  it("suppresses a redelivery before model, tools, reply, and media side effects", async () => {
    claimInboundDelivery.mockReturnValue({ acquired: false, reason: "duplicate" });
    const run = createInboundChannelRunner({ getContext: async () => context });
    await expect(run("telegram", {
      from: "42", name: "Peter", text: "do it", sessionId: "tg-42", deliveryId: "same",
    })).resolves.toBeNull();
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(forwardBridgeMedia).not.toHaveBeenCalled();
  });

  it("applies final replacement events to the channel reply", async () => {
    runChatTurn.mockImplementation(async ({ sseSink }) => {
      sseSink({ type: "stream", delta: "unsafe draft" });
      sseSink({ type: "stream", replace: true, text: "clean final" });
    });
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run("whatsapp", { from: "7", name: "P", text: "x", sessionId: "wa-7" });
    expect(reply).toEqual({ text: "clean final", speakable: "clean final" });
  });
});
