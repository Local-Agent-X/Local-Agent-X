// Opus codec + resampler tests. The codec is wasm-only (@evan/opus/wasm) so the
// roundtrip runs in-process with no native addon. Opus is lossy, so the encode
// -> decode assertion checks structural shape (960 samples back) plus a loose
// energy-preservation bound rather than exact sample equality.

import { describe, it, expect } from "vitest";
import {
  createOpusDecoder,
  createOpusEncoder,
  resampleInt16,
  OPUS_FRAME_SAMPLES,
  OPUS_SAMPLE_RATE,
} from "./opus-codec.js";

/** RMS energy of an Int16 frame. */
function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** One 20ms 48kHz mono Int16 sine frame. */
function sineFrame(freqHz: number, amplitude = 8000): Int16Array {
  const frame = new Int16Array(OPUS_FRAME_SAMPLES);
  for (let i = 0; i < OPUS_FRAME_SAMPLES; i++) {
    frame[i] = Math.round(
      Math.sin((2 * Math.PI * freqHz * i) / OPUS_SAMPLE_RATE) * amplitude,
    );
  }
  return frame;
}

describe("opus encode/decode roundtrip", () => {
  it("encodes a 960-sample 48kHz sine and decodes ~960 samples back, energy preserved", async () => {
    const encoder = await createOpusEncoder();
    const decoder = await createOpusDecoder();
    try {
      const input = sineFrame(440);

      const packet = encoder.encode(input);
      expect(packet).toBeInstanceOf(Uint8Array);
      expect(packet.length).toBeGreaterThan(0);

      const decoded = decoder.decode(packet);
      expect(decoded).toBeInstanceOf(Int16Array);
      // 48kHz/20ms always decodes back to exactly one 960-sample frame.
      expect(decoded.length).toBe(OPUS_FRAME_SAMPLES);

      // Lossy codec — assert energy ratio in a loose band, not equality.
      const inputRms = rms(input);
      const decodedRms = rms(decoded);
      expect(inputRms).toBeGreaterThan(0);
      const ratio = decodedRms / inputRms;
      expect(ratio).toBeGreaterThanOrEqual(0.3);
      expect(ratio).toBeLessThanOrEqual(3.0);
    } finally {
      encoder.free();
      decoder.free();
    }
  });
});

describe("resampleInt16", () => {
  it("16000 -> 48000 upsample of N samples yields ~3N samples", () => {
    const n = 320; // 20ms @ 16kHz
    const input = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * 6000);
    }
    const up = resampleInt16(input, 16000, 48000);
    expect(up.length).toBe(3 * n); // 960
  });

  it("equal rates returns a copy (same values, distinct buffer)", () => {
    const input = new Int16Array([1, -2, 3, -4, 5]);
    const out = resampleInt16(input, 16000, 16000);
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(out.buffer).not.toBe(input.buffer);
  });

  it("round-trip 48000 -> 16000 -> 48000 preserves length within +/-1%", () => {
    const n = 4800; // 100ms @ 48kHz
    const input = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000);
    }
    const down = resampleInt16(input, 48000, 16000);
    const up = resampleInt16(down, 16000, 48000);
    const drift = Math.abs(up.length - n) / n;
    expect(drift).toBeLessThanOrEqual(0.01);
  });

  it("clamps interpolated values into Int16 range", () => {
    const input = new Int16Array([32767, -32768, 32767, -32768]);
    const out = resampleInt16(input, 16000, 48000);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});
