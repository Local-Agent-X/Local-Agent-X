import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage, sendVoice } = vi.hoisted(() => ({ sendMessage: vi.fn(), sendVoice: vi.fn() }));
vi.mock("../bridge-voice/index.js", () => ({
  getVoicePref: () => false,
  isFfmpegAvailable: async () => true,
  splitForVoiceChunks: () => ["first", "second"],
  encodeWavToOgg: async () => Buffer.from("ogg"),
}));
vi.mock("../voice/index.js", () => ({ synthesize: async () => Buffer.from("wav") }));
vi.mock("./api.js", () => ({
  apiCall: vi.fn(), downloadTelegramFile: vi.fn(), sendMessage, sendVoice,
}));

const { dispatchReply } = await import("./inbound.js");
const { _voiceMirrorForChat } = await import("./types.js");

describe("Telegram durable voice delivery", () => {
  beforeEach(() => _voiceMirrorForChat.add("42"));

  it("falls back to the full text when a later voice chunk fails", async () => {
    sendVoice.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    sendMessage.mockResolvedValue(true);
    await expect(dispatchReply("token", "42", "full reply", "full reply")).resolves.toBe(true);
    expect(sendVoice).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2]).toContain("full reply");
  });

  it("resumes in fallback mode without resending an accepted voice chunk", async () => {
    const completed = new Set<string>();
    let plan: import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan | undefined;
    sendVoice.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    sendMessage.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const progress = {
      isDeliveryPartComplete: (part: string) => completed.has(part),
      acknowledgeDeliveryPart: async (part: string) => { completed.add(part); },
      readDeliveryPlan: () => plan,
      writeDeliveryPlan: async (next: import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan) => { plan = next; },
    };
    await expect(dispatchReply("token", "42", "full reply", "full reply", progress)).resolves.toBe(false);
    _voiceMirrorForChat.delete("42");
    await expect(dispatchReply("token", "42", "full reply", "full reply", progress)).resolves.toBe(true);
    expect(sendVoice).toHaveBeenCalledTimes(2);
    expect(completed).toContain("voice:0");
    expect(plan?.mode).toBe("fallback");
    expect(sendMessage.mock.calls[0][2]).toBe(sendMessage.mock.calls[1][2]);
  });
});
