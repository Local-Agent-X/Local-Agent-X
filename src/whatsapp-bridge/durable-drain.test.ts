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
