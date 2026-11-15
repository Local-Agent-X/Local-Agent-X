// The desktop's voice player (public/js/voice/playback-worklet.js) plays every
// sample of a reply, in order, however fast the sidecar sends it.
//
// 2026-11-15: Kokoro synthesized a 45 s reply in 8 s and the sidecar streamed it
// as it was made. The player's ring was fixed at 20 s of 24 kHz audio and a full
// ring overwrote its oldest unplayed samples, so the middle of the reply — whole
// sentences — was never heard. This drives the real worklet source.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/voice/playback-worklet.js"), "utf8");

interface Processor {
  port: { onmessage: (e: { data: unknown }) => void; postMessage: (m: unknown) => void };
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  ring: Float32Array;
}

/** Instantiate the worklet with a 24 kHz context, so one input sample is one output sample. */
function load(): Processor {
  let Ctor: (new () => Processor) | null = null;
  class AudioWorkletProcessor {
    port = { onmessage: (_e: { data: unknown }) => {}, postMessage: (_m: unknown) => {} };
  }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", SRC)(
    AudioWorkletProcessor,
    (_name: string, c: new () => Processor) => { Ctor = c; },
    24000,
  );
  return new Ctor!();
}

/** Samples numbered 0..n-1 (mod 32000), so play order is checkable. */
function numbered(from: number, n: number): ArrayBuffer {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = (from + i) % 32000;
  return a.buffer;
}

function playAll(p: Processor, n: number): number[] {
  const heard: number[] = [];
  const out = [new Float32Array(128)];
  for (let done = 0; done < n; done += 128) {
    p.process([], [out]);
    for (const s of out[0]) heard.push(Math.round(s * 0x8000));
  }
  return heard.slice(0, n);
}

describe("voice playback worklet", () => {
  it("plays a 45 s reply that arrived all at once, every sample in order", () => {
    const p = load();
    p.port.onmessage({ data: { cmd: "setRate", rate: 24000 } });
    const total = 24000 * 45;
    const chunk = 24000 * 0.1;
    for (let at = 0; at < total; at += chunk) p.port.onmessage({ data: { cmd: "pcm", pcm: numbered(at, chunk) } });
    const heard = playAll(p, total);
    expect(heard.length).toBe(total);
    const wrong = heard.findIndex((s, i) => s !== i % 32000);
    expect(wrong).toBe(-1);
  });

  it("keeps order when the ring grows while it has wrapped", () => {
    const p = load();
    const start = p.ring.length;
    p.port.onmessage({ data: { cmd: "pcm", pcm: numbered(0, start - 1000) } });
    const first = playAll(p, start - 5120); // whole 128-sample blocks, so nothing is played unrecorded
    p.port.onmessage({ data: { cmd: "pcm", pcm: numbered(start - 1000, 2000) } }); // wraps the write index
    expect(p.ring.length).toBe(start);
    p.port.onmessage({ data: { cmd: "pcm", pcm: numbered(start + 1000, start) } });
    expect(p.ring.length).toBeGreaterThan(start);
    const rest = playAll(p, start + 6120);
    const heard = [...first, ...rest];
    expect(heard.findIndex((s, i) => s !== i % 32000)).toBe(-1);
  });

  it("a barge-in flush empties the ring and returns it to its starting size", () => {
    const p = load();
    const start = p.ring.length;
    p.port.onmessage({ data: { cmd: "pcm", pcm: numbered(0, start * 3) } });
    expect(p.ring.length).toBeGreaterThan(start);
    p.port.onmessage({ data: { cmd: "flush" } });
    expect(p.ring.length).toBe(start);
    const out = [new Float32Array(128)];
    p.process([], [out]);
    expect(out[0].every((s) => s === 0)).toBe(true);
  });
});
