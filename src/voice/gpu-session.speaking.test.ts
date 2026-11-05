// What the GPU session hands the sidecar to speak: whole sentences, so every voice
// (built-in or cloned) says a sentence with one intonation instead of comma fragments.
import { describe, expect, it, vi } from "vitest";
import type { GPUBridgeCallbacks } from "./gpu-bridge.js";
import type { VoiceSessionContext } from "./audio-ws.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

const spoken: string[] = [];
let callbacks: GPUBridgeCallbacks | undefined;
vi.mock("./gpu-bridge.js", () => ({
  createGPUBridge: (cb: GPUBridgeCallbacks) => {
    callbacks = cb;
    return {
      ready: () => new Promise(() => {}),
      feedAudio: () => {},
      flush: () => {},
      speak: (text: string) => { spoken.push(text); },
      cancelTTS: () => {},
      reset: () => {},
      close: () => {},
      ttsSampleRate: 24000,
      micSampleRate: 16000,
    };
  },
}));
vi.mock("./voice-session/settings.js", () => ({ resolveVoiceSettings: () => ({}) }));

const { createGpuSession } = await import("./gpu-session.js");

describe("gpu session speaking", () => {
  it("sends each sentence to the sidecar whole, commas and all", async () => {
    const reply: VoiceTurnRunner = async ({ history, onDelta }) => {
      onDelta("Yeah, it's a quick way to find out. A legit company has that report ready,");
      onDelta(" and if they stall or dodge it, you know.");
      return { assistantText: "", updatedHistory: history };
    };
    const ctx = {
      sessionId: "gpu-speaking", mode: "chat", clientStt: true,
      sendAudio: () => {}, sendEvent: () => {},
    } as unknown as VoiceSessionContext;
    const s = createGpuSession(ctx, reply);
    callbacks!.onReady?.("test-gpu");
    s.onTranscript!("Is calling them worth it?", true);
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken).toEqual([
      "Yeah, it's a quick way to find out.",
      "A legit company has that report ready, and if they stall or dodge it, you know.",
    ]);
    s.close();
  });
});
