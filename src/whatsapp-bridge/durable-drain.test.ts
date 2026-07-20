import { describe, expect, it, vi } from "vitest";

const { listRecoverableInboundRequests } = vi.hoisted(() => ({ listRecoverableInboundRequests: vi.fn() }));
vi.mock("../server/inbound-delivery-store.js", () => ({ listRecoverableInboundRequests }));
const { createWhatsAppDurableDrainer, drainRecoverableWhatsApp } = await import("./durable-drain.js");

describe("WhatsApp durable startup drain", () => {
  it("routes persisted response-ready envelopes after restart", async () => {
    listRecoverableInboundRequests.mockReturnValue([{
      from: "1555", name: "Peter", text: "hello", sessionId: "wa-1555",
      deliveryId: "message:restart", deliveryFingerprint: "stable", deliveryTarget: "owner@lid",
    }]);
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn().mockResolvedValue({ text: "saved", speakable: "saved", acknowledgeDelivery });
    const dispatch = vi.fn().mockResolvedValue(true);
    await expect(drainRecoverableWhatsApp({ onMessage, dispatch })).resolves.toBe(false);
    expect(dispatch).toHaveBeenCalledWith("owner@lid", "1555", expect.objectContaining({ text: "saved" }));
    expect(acknowledgeDelivery).toHaveBeenCalledWith(true);
  });

  it("does not let one poison receipt block a later recoverable receipt", async () => {
    listRecoverableInboundRequests.mockReturnValue([
      { from: "1111", name: "Poison", text: "bad", sessionId: "wa-1111", deliveryId: "message:poison" },
      { from: "2222", name: "Peter", text: "good", sessionId: "wa-2222", deliveryId: "message:good" },
    ]);
    const poison = new Error("deterministic receipt failure");
    const acknowledgeDelivery = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn()
      .mockRejectedValueOnce(poison)
      .mockResolvedValueOnce({ text: "saved", speakable: "saved", acknowledgeDelivery });
    const dispatch = vi.fn().mockResolvedValue(true);

    await expect(drainRecoverableWhatsApp({ onMessage, dispatch })).rejects.toBe(poison);

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith("2222@s.whatsapp.net", "2222", expect.objectContaining({ text: "saved" }));
    expect(acknowledgeDelivery).toHaveBeenCalledWith(true);
  });

  it("releases a dispatch-failed receipt before draining the next receipt", async () => {
    listRecoverableInboundRequests.mockReturnValue([
      { from: "1111", name: "First", text: "one", sessionId: "wa-1111", deliveryId: "message:dispatch-fail" },
      { from: "2222", name: "Second", text: "two", sessionId: "wa-2222", deliveryId: "message:next" },
    ]);
    const dispatchFailure = new Error("transport failed");
    const firstAcknowledgement = vi.fn().mockResolvedValue(undefined);
    const secondAcknowledgement = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn()
      .mockResolvedValueOnce({ text: "first", speakable: "first", acknowledgeDelivery: firstAcknowledgement })
      .mockResolvedValueOnce({ text: "second", speakable: "second", acknowledgeDelivery: secondAcknowledgement });
    const dispatch = vi.fn()
      .mockRejectedValueOnce(dispatchFailure)
      .mockResolvedValueOnce(true);

    await expect(drainRecoverableWhatsApp({ onMessage, dispatch })).rejects.toBe(dispatchFailure);

    expect(firstAcknowledgement).toHaveBeenCalledTimes(1);
    expect(firstAcknowledgement).toHaveBeenCalledWith(false);
    expect(secondAcknowledgement).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries autonomously until a deferred envelope can be delivered", async () => {
    vi.useFakeTimers();
    listRecoverableInboundRequests.mockReturnValue([{
      from: "1555", name: "Peter", text: "hello", sessionId: "wa-1555",
      deliveryId: "message:retry", deliveryFingerprint: "stable",
    }]);
    const onMessage = vi.fn()
      .mockResolvedValueOnce({ text: "", deferDelivery: true })
      .mockResolvedValueOnce(null);
    const trigger = createWhatsAppDurableDrainer({
      onMessage,
      dispatch: vi.fn(),
      isConnected: () => true,
      onError: vi.fn(),
      retryDelayMs: 10,
    });

    trigger();
    await vi.advanceTimersByTimeAsync(10);

    expect(onMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
