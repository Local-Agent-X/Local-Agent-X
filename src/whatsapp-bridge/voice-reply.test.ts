import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge-voice/index.js", () => ({
  getVoicePref: () => false,
  isFfmpegAvailable: async () => true,
  splitForVoiceChunks: () => ["first", "second"],
  encodeWavToOgg: async () => Buffer.from("ogg"),
}));
vi.mock("../voice/index.js", () => ({ synthesize: async () => Buffer.from("wav") }));

const { clearVoiceMirror, dispatchReplyToJid, markVoiceMirror } = await import("./voice-reply.js");

describe("WhatsApp durable voice delivery", () => {
  beforeEach(() => markVoiceMirror("1555"));

  it("falls back to the full text when a later voice chunk fails", async () => {
    const sendVoiceToJid = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const sendToJid = vi.fn().mockResolvedValue(true);
    await expect(dispatchReplyToJid(
      { sendToJid, sendVoiceToJid }, "jid", "1555", { text: "full reply", speakable: "full reply" },
    )).resolves.toBe(true);
    expect(sendVoiceToJid).toHaveBeenCalledTimes(2);
    expect(sendToJid.mock.calls[0][1]).toContain("full reply");
  });

  it("resumes a failed fallback without replaying an accepted voice chunk", async () => {
    const completed = new Set<string>();
    let plan: import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan | undefined;
    const sendVoiceToJid = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const sendToJid = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reply = {
      text: "full reply", speakable: "full reply",
      isDeliveryPartComplete: (part: string) => completed.has(part),
      acknowledgeDeliveryPart: async (part: string) => { completed.add(part); },
      readDeliveryPlan: () => plan,
      writeDeliveryPlan: async (next: import("../server/inbound-delivery-store.js").DurableInboundDeliveryPlan) => { plan = next; },
    };
    await expect(dispatchReplyToJid({ sendToJid, sendVoiceToJid }, "jid", "1555", reply)).resolves.toBe(false);
    clearVoiceMirror("1555");
    await expect(dispatchReplyToJid({ sendToJid, sendVoiceToJid }, "jid", "1555", reply)).resolves.toBe(true);
    expect(sendVoiceToJid).toHaveBeenCalledTimes(2);
    expect(completed).toContain("voice:0");
    expect(completed).toContain("fallback-text:0");
    expect(plan?.mode).toBe("fallback");
    expect(sendToJid.mock.calls[0][1]).toBe(sendToJid.mock.calls[1][1]);
  });
});
