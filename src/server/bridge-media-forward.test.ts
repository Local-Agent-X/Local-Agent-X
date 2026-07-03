// Regression (BR-8): when outbound media is BLOCKED after the turn ended, the
// model's "here's your video!" text has already shipped. Pre-fix, every block
// site (egress gate, secret-scan, canary, oversize) only logger.warn'd and
// continued, so the user was left waiting on media that never arrives. The fix
// sends a one-line text notice over the SAME bridge on block. These pin: a
// blocked send emits a notice (and no media), and a clean send emits no notice.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Force the secret-scan gate to trip so we exercise the block path deterministically.
const scanClean = { clean: true, findings: [] as unknown[] };
const scanState = { value: scanClean as { clean: boolean; findings: unknown[] } };
vi.mock("../security/secret-scanner.js", () => ({
  scanForSecrets: () => scanState.value,
}));
// Keep the canary tripwire quiet so it never masks/duplicates the assertion.
vi.mock("../threat/canaries.js", () => ({
  checkCanariesInPayload: () => false,
}));

import { forwardBridgeMedia } from "./bridge-media-forward.js";
import { enqueueBridgeMedia } from "../bridge-media-queue.js";

function makeBridges() {
  const wa = { sendMessage: vi.fn().mockResolvedValue(true), sendImage: vi.fn().mockResolvedValue(true), sendVideo: vi.fn().mockResolvedValue(true) };
  const tg = { sendMessage: vi.fn().mockResolvedValue(true), sendPhoto: vi.fn().mockResolvedValue(true), sendVideo: vi.fn().mockResolvedValue(true) };
  return { wa, tg };
}

// An unknown (non-raster) payload is text-bearing, so it flows through the
// secret-scan gate we control above.
const textBearingImageB64 = Buffer.from("not-a-real-image-payload").toString("base64");

describe("forwardBridgeMedia block-notice (BR-8)", () => {
  beforeEach(() => {
    scanState.value = scanClean;
  });

  it("sends a one-line text notice over the SAME bridge when a secret-scan block drops the image", async () => {
    scanState.value = { clean: false, findings: [{}] };
    const { wa, tg } = makeBridges();
    const opId = "op-block-1";
    enqueueBridgeMedia(opId, { imageB64: [textBearingImageB64] });

    await forwardBridgeMedia({
      canonicalOpId: opId,
      channelType: "whatsapp",
      platform: "whatsapp",
      from: "user@wa",
      sessionKey: "sess-1",
      getWhatsappBridge: () => wa as never,
      getTelegramBridge: () => tg as never,
    });

    // The media itself must NOT ship...
    expect(wa.sendImage).not.toHaveBeenCalled();
    // ...but the user must be told, over the same (whatsapp) bridge.
    expect(wa.sendMessage).toHaveBeenCalledTimes(1);
    expect(wa.sendMessage.mock.calls[0][0]).toBe("user@wa");
    expect(String(wa.sendMessage.mock.calls[0][1]).toLowerCase()).toContain("couldn't send");
    // Nothing leaks onto the other bridge.
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it("sends no notice on a clean image forward (the send succeeds)", async () => {
    scanState.value = scanClean;
    const { wa, tg } = makeBridges();
    const opId = "op-clean-1";
    enqueueBridgeMedia(opId, { imageB64: [textBearingImageB64] });

    await forwardBridgeMedia({
      canonicalOpId: opId,
      channelType: "whatsapp",
      platform: "whatsapp",
      from: "user@wa",
      sessionKey: "sess-2",
      getWhatsappBridge: () => wa as never,
      getTelegramBridge: () => tg as never,
    });

    expect(wa.sendImage).toHaveBeenCalledTimes(1);
    expect(wa.sendMessage).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });
});
