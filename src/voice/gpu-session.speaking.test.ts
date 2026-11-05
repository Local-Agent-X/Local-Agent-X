// What the GPU session hands the sidecar: whole sentences to speak, so every voice
// (built-in or cloned) says a sentence with one intonation instead of comma fragments;
// and, when the desktop listens, what the reply has said so far as Whisper's context.
import { describe, expect, it, vi } from "vitest";
import type { GPUBridgeCallbacks } from "./gpu-bridge.js";
import type { VoiceSessionContext } from "./audio-ws.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

const spoken: string[] = [];
const contexts: string[] = [];
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
      setSttContext: (text: string) => { contexts.push(text); },
      close: () => {},
      ttsSampleRate: 24000,
      micSampleRate: 16000,
    };
  },
}));
vi.mock("./voice-session/settings.js", () => ({ resolveVoiceSettings: () => ({}) }));

const { createGpuSession } = await import("./gpu-session.js");

const reply: VoiceTurnRunner = async ({ history, onDelta }) => {
  onDelta("Yeah, it's a quick way to find out. A legit company has that report ready,");
  onDelta(" and if they stall or dodge it, you know.");
  return { assistantText: "", updatedHistory: history };
};

function session(clientStt: boolean) {
  spoken.length = 0;
  contexts.length = 0;
  const ctx = {
    sessionId: `gpu-speaking-${clientStt}`, mode: "chat", clientStt,
    sendAudio: () => {}, sendEvent: () => {},
  } as unknown as VoiceSessionContext;
  const s = createGpuSession(ctx, reply);
  callbacks!.onReady?.("test-gpu");
  return s;
}

describe("gpu session speaking", () => {
  it("sends each sentence to the sidecar whole, commas and all", async () => {
    const s = session(true);
    s.onTranscript!("Is calling them worth it?", true);
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken).toEqual([
      "Yeah, it's a quick way to find out.",
      "A legit company has that report ready, and if they stall or dodge it, you know.",
    ]);
    expect(contexts).toEqual([]); // the phone listens: the sidecar transcribes nothing
    s.close();
  });

  it("gives the desktop's Whisper what the reply has said so far as its context", async () => {
    const s = session(false);
    callbacks!.onFinal?.("Is calling them worth it?", 40);
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    expect(contexts).toEqual([
      "Yeah, it's a quick way to find out.",
      "Yeah, it's a quick way to find out. A legit company has that report ready, and if they stall or dodge it, you know.",
    ]);
    s.close();
  });
});
