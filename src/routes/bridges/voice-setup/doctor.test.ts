import { describe, it, expect } from "vitest";
import { parseWavPcm16, resampleLinear, transcriptMatches } from "./doctor.js";

// Build a minimal valid RIFF/WAVE PCM16 buffer in memory.
function makeWav(samples: number[], sampleRate: number, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(s * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("voice doctor WAV parsing", () => {
  it("round-trips PCM16 samples and sample rate", () => {
    const wav = makeWav([0, 0.5, -0.5, 1], 24000);
    const { samples, sampleRate } = parseWavPcm16(wav);
    expect(sampleRate).toBe(24000);
    expect(samples.length).toBe(4);
    expect(samples[1]).toBeCloseTo(0.5, 2);
    expect(samples[2]).toBeCloseTo(-0.5, 2);
  });

  it("rejects non-WAV bytes instead of returning garbage audio", () => {
    expect(() => parseWavPcm16(Buffer.from("this is not a wav file at all, not even a little"))).toThrow();
  });

  it("mono-mixes stereo data", () => {
    // L=1.0, R=0.0 for every frame → mixed 0.5
    const stereo = makeWav([1, 0, 1, 0], 24000, 2);
    const { samples } = parseWavPcm16(stereo);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(0.5, 2);
  });
});

describe("voice doctor resample", () => {
  it("halves the length going 48k→24k and preserves endpoints", () => {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]);
    const out = resampleLinear(src, 48000, 24000);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it("is identity at equal rates", () => {
    const src = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(src, 16000, 16000)).toBe(src);
  });
});

describe("voice doctor transcript match", () => {
  const expected = "The quick brown fox jumps over the lazy dog.";
  it("accepts a normal whisper-grade transcript with small errors", () => {
    expect(transcriptMatches("A quick brown fox jumps over the lazy dog", expected)).toBe(true);
  });
  it("rejects an unrelated transcript (a broken STT that emits noise must FAIL the check)", () => {
    expect(transcriptMatches("thanks for watching", expected)).toBe(false);
    expect(transcriptMatches("", expected)).toBe(false);
  });
});
