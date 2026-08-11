import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the KittenTTS engine so the test never downloads the ~23MB ONNX model.
// The mock mirrors the real engine's shape; each synth() resolves immediately
// so we can assert the shared streaming adapter delivers audio for the kitten
// provider exactly as it does for kokoro.
vi.mock("../src/voice/tier4/kitten-engine.js", () => ({
  createKittenEngine: vi.fn(async () => ({
    synth: vi.fn(async () => ({ audio: new Float32Array(64).fill(0.2), sampling_rate: 24000 })),
    close: vi.fn(async () => {}),
    sampleRate: 24000,
    voice: "expr-voice-2-m",
    modelId: "onnx-community/kitten-tts-nano-0.1-ONNX",
    runtime: { device: "cpu", dtype: "q8", fellBack: false },
  })),
  KITTEN_MODEL_ID: "onnx-community/kitten-tts-nano-0.1-ONNX",
}));

import { createTier4, listTtsProviders } from "../src/voice/tier4/tier4-factory.js";
import { hasTtsProvider } from "../src/voice/tier4/registry.js";
import { snapshotTier4Diag } from "../src/voice/tier4/streaming-tts.js";
import {
  KITTEN_VOICES,
  KITTEN_DEFAULT_VOICE,
  isValidKittenVoice,
  kittenVoiceList,
  kittenVoiceMeta,
} from "../src/voice/tier4/kitten-voices.js";
import { phonemizeKitten } from "../src/voice/tier4/kitten-phonemize.js";

function flushTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("kitten provider registration", () => {
  it("is registered in the tier-4 registry", () => {
    expect(hasTtsProvider("kitten")).toBe(true);
  });

  it("appears in listTtsProviders() so a provider-picker UI can surface it", () => {
    const names = listTtsProviders().map((p) => p.name);
    expect(names).toContain("kitten");
    expect(names).toContain("kokoro"); // didn't clobber the default
  });
});

describe("createTier4({ variant: 'kitten' })", () => {
  it("returns a streaming TTS bound to the kitten engine (24kHz), and speaks", async () => {
    const onAudio = vi.fn();
    const onIdle = vi.fn();
    const tts = await createTier4(
      { variant: "kitten", device: "cpu", dtype: "q8" },
      { onAudio, onIdle },
    );

    expect(typeof tts.speak).toBe("function");
    expect(typeof tts.cancel).toBe("function");
    expect(typeof tts.close).toBe("function");
    expect(tts.sampleRate).toBe(24000);

    tts.speak("hello from kitten");
    await flushTask();
    expect(onAudio).toHaveBeenCalledTimes(1);
    await flushTask();
    expect(onIdle).toHaveBeenCalled();

    // diag.modelId reflects the kitten engine, not the kokoro config default —
    // proves the engine-factory swap actually took effect.
    const diag = snapshotTier4Diag(tts);
    expect(diag?.modelId).toBe("onnx-community/kitten-tts-nano-0.1-ONNX");

    tts.close();
  });
});

describe("kitten-voices", () => {
  it("exposes exactly the eight expr-voice ids", () => {
    expect(KITTEN_VOICES.size).toBe(8);
    for (const id of ["expr-voice-2-m", "expr-voice-5-f"]) {
      expect(KITTEN_VOICES.has(id)).toBe(true);
    }
  });

  it("default voice is the natural male expr-voice-2-m", () => {
    expect(KITTEN_DEFAULT_VOICE).toBe("expr-voice-2-m");
    expect(isValidKittenVoice(KITTEN_DEFAULT_VOICE)).toBe(true);
  });

  it("rejects unknown / kokoro voices", () => {
    expect(isValidKittenVoice("am_michael")).toBe(false);
    expect(isValidKittenVoice("expr-voice-9-m")).toBe(false);
    expect(isValidKittenVoice(undefined)).toBe(false);
  });

  it("infers gender from the id suffix", () => {
    expect(kittenVoiceMeta("expr-voice-3-f").gender).toBe("female");
    expect(kittenVoiceMeta("expr-voice-4-m").gender).toBe("male");
    expect(kittenVoiceList().length).toBe(8);
  });
});

describe("phonemizeKitten — punctuation-pause fidelity", () => {
  // Fake espeak: uppercases each word run so we can see punctuation survive.
  const fakePhonemize = async (text: string): Promise<string[]> => [
    text.trim().toUpperCase().replace(/\s+/g, "_"),
  ];

  it("preserves em-dash and paren pauses that a naive phonemize would drop", async () => {
    const out = await phonemizeKitten("Wait — really (I mean it)?", fakePhonemize);
    // em-dash pause kept…
    expect(out).toContain("—");
    // …and parens are normalized to guillemets but still kept as pause cues.
    expect(out).toContain("«");
    expect(out).toContain("»");
    // question mark kept too.
    expect(out).toContain("?");
  });

  it("phonemizes the word runs (not the punctuation)", async () => {
    const out = await phonemizeKitten("Hello world", fakePhonemize);
    expect(out).toContain("HELLO_WORLD");
  });
});
