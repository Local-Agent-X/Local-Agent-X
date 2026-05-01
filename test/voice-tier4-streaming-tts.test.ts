import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the kokoro engine so we don't actually load 80MB of weights.
// Each `synth()` returns a controllable promise that we resolve manually
// from inside the test, which lets us reproduce the cancel-then-speak
// race that round 12's epoch counter fixes.
type Resolver = (audio: { audio: Float32Array; sampling_rate: number }) => void;

const pendingSynths: Resolver[] = [];

vi.mock("../src/voice/tier4/kokoro-engine.js", () => ({
  createKokoroEngine: vi.fn(async () => ({
    synth: vi.fn((_text: string) =>
      new Promise<{ audio: Float32Array; sampling_rate: number }>((resolve) => {
        pendingSynths.push(resolve);
      }),
    ),
    close: vi.fn(async () => {}),
    sampleRate: 24000,
    voice: "am_michael",
    modelId: "test",
    runtime: { device: "cpu", dtype: "q8", fellBack: false },
  })),
  float32ToInt16: (src: Float32Array) => {
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = (src[i] * 0x7fff) | 0;
    return out;
  },
}));

import { createTier4StreamingTTS } from "../src/voice/tier4/streaming-tts.js";

function flushTask(): Promise<void> {
  // Lets pending microtasks (then handlers attached to a resolved synth)
  // run before we make the next assertion.
  return new Promise((r) => setTimeout(r, 0));
}

describe("createTier4StreamingTTS — cancel + speak race", () => {
  beforeEach(() => {
    pendingSynths.length = 0;
  });

  afterEach(() => {
    pendingSynths.length = 0;
  });

  it("drops audio for a sentence that was cancelled mid-synth, even if speak() ran before the synth resolved", async () => {
    const onAudio = vi.fn();
    const onIdle = vi.fn();
    const tts = await createTier4StreamingTTS(
      { device: "cpu", dtype: "q8" },
      { onAudio, onIdle },
    );

    tts.speak("first");
    await flushTask();
    expect(pendingSynths.length).toBe(1);

    // User barges in. cancel() bumps the epoch and clears the queue.
    tts.cancel();
    // Mid-await, a NEW utterance arrives. The pre-fix code would reset
    // state.cancelled to false here, so when the original synth resolves
    // its audio would leak through as if it weren't cancelled.
    tts.speak("second");
    await flushTask();

    // Resolve the FIRST (cancelled) synth's audio. Without the epoch fix
    // this would call onAudio for the cancelled sentence.
    const firstResolver = pendingSynths.shift()!;
    firstResolver({ audio: new Float32Array(100).fill(0.1), sampling_rate: 24000 });
    await flushTask();

    expect(onAudio).not.toHaveBeenCalled();

    // The second sentence should now be in flight as a brand-new synth.
    expect(pendingSynths.length).toBe(1);
    const secondResolver = pendingSynths.shift()!;
    secondResolver({ audio: new Float32Array(50).fill(0.2), sampling_rate: 24000 });
    await flushTask();

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    tts.close();
  });

  it("delivers audio normally when no cancel happens between speak and synth resolution", async () => {
    const onAudio = vi.fn();
    const tts = await createTier4StreamingTTS(
      { device: "cpu", dtype: "q8" },
      { onAudio },
    );

    tts.speak("hello");
    await flushTask();
    expect(pendingSynths.length).toBe(1);
    pendingSynths.shift()!({ audio: new Float32Array(40).fill(0.3), sampling_rate: 24000 });
    await flushTask();

    expect(onAudio).toHaveBeenCalledTimes(1);
    tts.close();
  });

  it("epoch bump on close() also drops in-flight audio", async () => {
    const onAudio = vi.fn();
    const tts = await createTier4StreamingTTS(
      { device: "cpu", dtype: "q8" },
      { onAudio },
    );

    tts.speak("hello");
    await flushTask();
    expect(pendingSynths.length).toBe(1);

    tts.close();
    pendingSynths.shift()!({ audio: new Float32Array(40).fill(0.4), sampling_rate: 24000 });
    await flushTask();

    expect(onAudio).not.toHaveBeenCalled();
  });
});
