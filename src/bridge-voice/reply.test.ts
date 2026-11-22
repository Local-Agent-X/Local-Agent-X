// A bridge's reply, by voice or by text, in one place. Telegram and WhatsApp
// each carried this dispatcher line for line; their own delivery tests
// (telegram-bridge/reply-delivery.test.ts, whatsapp-bridge/voice-reply.test.ts)
// still run through it. These pin what the two copies had no test for: which
// mode a reply takes, and that the "voice is down" hint is said once per chat.
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ voicePref: false, ffmpeg: true, synthFails: false }));
vi.mock("./index.js", () => ({
  getVoicePref: () => env.voicePref,
  isFfmpegAvailable: async () => env.ffmpeg,
  splitForVoiceChunks: (text: string) => text.split("|"),
  encodeWavToOgg: async (wav: Buffer) => Buffer.from(`ogg(${wav})`),
}));
vi.mock("../voice/index.js", () => ({
  synthesize: async (text: string) => {
    if (env.synthFails) throw new Error("engine down");
    return Buffer.from(text);
  },
}));

const { sendVoiceOrTextReply } = await import("./reply.js");

let chatSeq = 0;
function reply(over: Partial<Parameters<typeof sendVoiceOrTextReply>[0]> = {}) {
  const texts: Array<[string, string]> = [];
  const voices: string[] = [];
  const target = {
    platform: "telegram" as const, chatId: `chat-${chatSeq++}`, mirrorVoice: false,
    textForWire: "the reply", speakable: "one|two",
    sendText: async (text: string, prefix: string) => { texts.push([prefix, text]); return true; },
    sendVoice: async (ogg: Buffer) => { voices.push(String(ogg)); return true; },
    ...over,
  };
  return { target, texts, voices };
}

beforeEach(() => { env.voicePref = false; env.ffmpeg = true; env.synthFails = false; });

describe("sendVoiceOrTextReply", () => {
  it("sends text when the chat has voice off and the turn did not come by voice", async () => {
    const r = reply();
    expect(await sendVoiceOrTextReply(r.target)).toBe(true);
    expect(r.texts).toEqual([["text", "the reply"]]);
    expect(r.voices).toEqual([]);
  });

  it("sends every chunk as a voice note when the chat has voice on, or the turn came by voice", async () => {
    env.voicePref = true;
    const byPreference = reply();
    expect(await sendVoiceOrTextReply(byPreference.target)).toBe(true);
    expect(byPreference.voices).toEqual(["ogg(one)", "ogg(two)"]);
    expect(byPreference.texts).toEqual([]);

    env.voicePref = false;
    const byMirror = reply({ mirrorVoice: true });
    expect(await sendVoiceOrTextReply(byMirror.target)).toBe(true);
    expect(byMirror.voices).toEqual(["ogg(one)", "ogg(two)"]);
  });

  it("falls back to the full text with a hint when the engine fails, and says the hint once per chat", async () => {
    env.synthFails = true;
    const first = reply({ mirrorVoice: true, chatId: "same-chat" });
    expect(await sendVoiceOrTextReply(first.target)).toBe(true);
    expect(first.texts).toHaveLength(1);
    expect(first.texts[0][0]).toBe("fallback-text");
    expect(first.texts[0][1]).toMatch(/^the reply\n\n--- Voice engine isn't reachable/);

    const second = reply({ mirrorVoice: true, chatId: "same-chat" });
    expect(await sendVoiceOrTextReply(second.target)).toBe(true);
    expect(second.texts).toEqual([["fallback-text", "the reply"]]);

    // The same chat id on the other platform is another chat.
    const otherPlatform = reply({ mirrorVoice: true, chatId: "same-chat", platform: "whatsapp" });
    await sendVoiceOrTextReply(otherPlatform.target);
    expect(otherPlatform.texts[0][1]).toContain("Voice engine isn't reachable");
  });

  it("says what is missing when ffmpeg is not installed", async () => {
    env.ffmpeg = false;
    const r = reply({ mirrorVoice: true });
    expect(await sendVoiceOrTextReply(r.target)).toBe(true);
    expect(r.texts[0][1]).toContain("Voice replies need ffmpeg");
    expect(r.voices).toEqual([]);
  });
});
