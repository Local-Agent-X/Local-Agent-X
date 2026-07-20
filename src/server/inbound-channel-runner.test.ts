import { beforeEach, describe, expect, it, vi } from "vitest";

const runChatTurn = vi.fn();
const forwardBridgeMedia = vi.fn();
const persistBridgeMedia = vi.fn();
const claimInboundDelivery = vi.fn();
const bindInboundOperation = vi.fn();
const markInboundResponseReady = vi.fn();
const acknowledgeInboundDelivery = vi.fn();
const releaseInboundClaim = vi.fn();
const readInboundDeliveryPlan = vi.fn();
const writeInboundDeliveryPlan = vi.fn();
const hasInboundDeliveryPart = vi.fn();
const markInboundDeliveryPart = vi.fn();
const readOp = vi.fn();
const readOpMessages = vi.fn();

vi.mock("../routes/chat/run-chat-turn.js", () => ({ runChatTurn }));
vi.mock("./bridge-media-forward.js", () => ({ forwardBridgeMedia }));
vi.mock("../bridge-media-queue.js", () => ({ persistBridgeMedia }));
vi.mock("./inbound-delivery-store.js", () => ({
  claimInboundDelivery, bindInboundOperation, markInboundResponseReady,
  acknowledgeInboundDelivery, releaseInboundClaim, readInboundDeliveryPlan,
  writeInboundDeliveryPlan, hasInboundDeliveryPart, markInboundDeliveryPart,
}));
vi.mock("../ops/op-store.js", () => ({ readOp }));
vi.mock("../canonical-loop/index.js", () => ({ readOpMessages }));

const { createInboundChannelRunner } = await import("./inbound-channel-runner.js");
const context = { whatsappBridge: { kind: "wa" }, telegramBridge: { kind: "tg" } } as never;
const claim = { receiptId: "receipt", generation: 1 };

describe("canonical inbound channel runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimInboundDelivery.mockReturnValue({ acquired: true, mode: "execute", claim });
    forwardBridgeMedia.mockResolvedValue(true);
    bindInboundOperation.mockReturnValue(true);
    markInboundResponseReady.mockReturnValue(true);
    acknowledgeInboundDelivery.mockReturnValue(true);
    releaseInboundClaim.mockReturnValue(true);
    readInboundDeliveryPlan.mockReturnValue(undefined);
    writeInboundDeliveryPlan.mockReturnValue(true);
    hasInboundDeliveryPart.mockReturnValue(false);
    markInboundDeliveryPart.mockReturnValue(true);
    readOp.mockReturnValue({ status: "completed" });
    readOpMessages.mockReturnValue([{ role: "assistant", messageId: "reply-1", content: { text: "recovered" } }]);
    runChatTurn.mockImplementation(async ({ sseSink }) => {
      sseSink({ type: "chat_op_started", opId: "op-1" });
      sseSink({ type: "stream", delta: "hello " });
      sseSink({ type: "stream", delta: "there" });
    });
  });

  it.each(["telegram", "whatsapp"] as const)("routes %s through canonical chat and publishes before media", async (channel) => {
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run(channel, {
      from: "42", name: "Peter", text: "do it", sessionId: `${channel}-42`, deliveryId: "d1", deliveryFingerprint: "stable-wire-message",
    });
    expect(claimInboundDelivery).toHaveBeenCalledWith(expect.objectContaining({ text: "stable-wire-message" }));
    expect(runChatTurn).toHaveBeenCalledTimes(1);
    expect(runChatTurn.mock.calls[0][0]).toMatchObject({ channel, message: "do it", requestRole: "operator", skipMemory: true, maxHistory: 30 });
    expect(bindInboundOperation).toHaveBeenCalledWith(claim, "op-1");
    expect(markInboundResponseReady).toHaveBeenCalledWith(claim, { text: "hello there", speakable: "hello there" });
    expect(markInboundResponseReady.mock.invocationCallOrder[0]).toBeLessThan(forwardBridgeMedia.mock.invocationCallOrder[0]);
    expect(reply?.acknowledgeDelivery).toBeTypeOf("function");
    await reply?.acknowledgeDelivery?.(true);
    expect(acknowledgeInboundDelivery).toHaveBeenCalledWith(claim, true);
  });

  it("freezes a voice-mirror transport plan before starting the canonical turn", async () => {
    const run = createInboundChannelRunner({ getContext: async () => context });
    await run("whatsapp", {
      from: "1555", name: "Peter", text: "transcript", sessionId: "wa-1555",
      deliveryId: "voice-1", deliveryTarget: "owner@lid", preferVoiceReply: true,
    });
    expect(writeInboundDeliveryPlan).toHaveBeenCalledWith(claim, { mode: "voice" });
    expect(writeInboundDeliveryPlan.mock.invocationCallOrder[0]).toBeLessThan(runChatTurn.mock.invocationCallOrder[0]);
  });

  it.each(["telegram", "whatsapp"] as const)("replays a durable unsent %s reply with no model, tool, or media effects", async (channel) => {
    claimInboundDelivery.mockReturnValue({ acquired: true, mode: "replay", claim, reply: { text: "saved", speakable: "raw" } });
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run(channel, { from: "42", name: "Peter", text: "do it", sessionId: `${channel}-42`, deliveryId: "same" });
    expect(reply).toMatchObject({ text: "saved", speakable: "raw" });
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(forwardBridgeMedia).not.toHaveBeenCalled();
    await reply?.acknowledgeDelivery?.(false);
    expect(acknowledgeInboundDelivery).toHaveBeenCalledWith(claim, false);
  });

  it("keeps a response ready and withholds text when durable media needs retry", async () => {
    forwardBridgeMedia.mockResolvedValue(false);
    const run = createInboundChannelRunner({ getContext: async () => context });
    await expect(run("telegram", { from: "42", name: "P", text: "x", sessionId: "tg-42", deliveryId: "same" }))
      .resolves.toMatchObject({ deferDelivery: true });
    expect(markInboundResponseReady).toHaveBeenCalledTimes(1);
    expect(acknowledgeInboundDelivery).toHaveBeenCalledWith(claim, false);
    expect(runChatTurn).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent and post-admission duplicates without rerunning effects", async () => {
    claimInboundDelivery.mockReturnValue({ acquired: false, reason: "delivered_duplicate" });
    const run = createInboundChannelRunner({ getContext: async () => context });
    await expect(run("telegram", { from: "42", name: "P", text: "x", sessionId: "tg-42", deliveryId: "same" })).resolves.toBeNull();
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(forwardBridgeMedia).not.toHaveBeenCalled();
  });

  it("keeps the provider delivery pending while its original owner is in progress", async () => {
    claimInboundDelivery.mockReturnValue({ acquired: false, reason: "in_progress" });
    const run = createInboundChannelRunner({ getContext: async () => context });
    await expect(run("telegram", { from: "42", name: "P", text: "x", sessionId: "tg-42", deliveryId: "same" }))
      .resolves.toMatchObject({ deferDelivery: true });
    expect(runChatTurn).not.toHaveBeenCalled();
  });

  it.each(["telegram", "whatsapp"] as const)("recovers a terminal bound %s operation without rerunning it", async (channel) => {
    claimInboundDelivery.mockReturnValue({ acquired: true, mode: "recover", claim, opId: "op-bound" });
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run(channel, { from: "42", name: "P", text: "x", sessionId: `${channel}-42`, deliveryId: "same" });
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(markInboundResponseReady).toHaveBeenCalledWith(claim, { text: "recovered", speakable: "recovered" });
    expect(forwardBridgeMedia).toHaveBeenCalledWith(expect.objectContaining({ canonicalOpId: "op-bound", channelType: channel }));
    expect(reply).toMatchObject({ text: "recovered", speakable: "recovered" });
  });

  it("releases a bound operation recovery lease until canonical recovery reaches terminal", async () => {
    claimInboundDelivery.mockReturnValue({ acquired: true, mode: "recover", claim, opId: "op-running" });
    readOp.mockReturnValue({ status: "running", canonical: { state: "running" } });
    const run = createInboundChannelRunner({ getContext: async () => context });
    await expect(run("telegram", { from: "42", name: "P", text: "x", sessionId: "tg-42", deliveryId: "same" }))
      .resolves.toMatchObject({ deferDelivery: true });
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(releaseInboundClaim).toHaveBeenCalledWith(claim);
  });

  it("applies final replacement events to non-durable channel replies", async () => {
    claimInboundDelivery.mockReturnValue(null);
    runChatTurn.mockImplementation(async ({ sseSink }) => {
      sseSink({ type: "stream", delta: "unsafe draft" });
      sseSink({ type: "stream", replace: true, text: "clean final" });
    });
    const run = createInboundChannelRunner({ getContext: async () => context });
    const reply = await run("whatsapp", { from: "7", name: "P", text: "x", sessionId: "wa-7" });
    expect(reply).toEqual({ text: "clean final", speakable: "clean final" });
  });
});
