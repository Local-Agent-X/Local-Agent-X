// Kokoro-82M engine wrapper.
//
// kokoro-js bundles @huggingface/transformers + phonemizer and ships an
// `KokoroTTS` class. We sit on top of it and expose a narrower surface so
// the rest of tier 4 doesn't have to know which library produced the audio.
//
// The .stream(splitter) generator yields { text, phonemes, audio } chunks
// where `audio` is a RawAudio with .audio (Float32Array) and .sampling_rate.
// We convert to Int16Array PCM at the boundary because every other voice
// tier in SAX speaks Int16 — keeping the same shape avoids a second
// converter further upstream.

import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";
import type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";
import { TIER4_DEFAULTS } from "./types.js";

type KokoroChunk = {
  text: string;
  phonemes?: string;
  audio: { audio: Float32Array; sampling_rate: number };
};

type SplitterCtor = new () => {
  push(text: string): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
};

type KokoroTTSCtor = {
  from_pretrained(
    modelId: string,
    opts: { dtype: Tier4Dtype; device: Tier4Device },
  ): Promise<{
    stream(splitter: InstanceType<SplitterCtor>, opts?: { voice?: string; speed?: number }): AsyncIterable<KokoroChunk>;
    list_voices?(): Record<string, unknown>;
  }>;
};

export interface KokoroEngine {
  push(text: string): void;
  endTurn(): void;
  cancel(): void;
  close(): Promise<void>;
  iterator(): AsyncIterableIterator<KokoroChunk>;
  readonly sampleRate: number;
  readonly voice: string;
  readonly modelId: string;
}

export interface KokoroEngineInit {
  config: Tier4Config;
  onLoad?: (ms: number) => void;
}

export async function createKokoroEngine(init: KokoroEngineInit): Promise<KokoroEngine> {
  const cfg = { ...TIER4_DEFAULTS, ...init.config };
  configureHFCache();

  const t0 = Date.now();
  const mod = (await import("kokoro-js")) as unknown as {
    KokoroTTS: KokoroTTSCtor;
    TextSplitterStream: SplitterCtor;
  };
  const tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, {
    dtype: cfg.dtype,
    device: cfg.device,
  });
  const loadMs = Date.now() - t0;
  init.onLoad?.(loadMs);

  let splitter = new mod.TextSplitterStream();
  let stream = tts.stream(splitter, { voice: cfg.voice, speed: cfg.speed });
  let cancelled = false;
  let sampleRate = 24000;

  const status = tier4ModelStatus(cfg.modelId);
  if (!status.cached && process.env.LAX_VOICE_DEBUG) {
    console.log(`[tier4/kokoro] cold start — first run will download to ${status.cacheDir}`);
  }

  async function* iterator() {
    while (!cancelled) {
      const it = stream[Symbol.asyncIterator]();
      const next = await it.next();
      if (next.done) return;
      const chunk = next.value;
      if (chunk?.audio?.sampling_rate) sampleRate = chunk.audio.sampling_rate;
      yield chunk;
    }
  }

  return {
    push(text: string) {
      if (!cancelled) splitter.push(text);
    },
    endTurn() {
      splitter.close();
      splitter = new mod.TextSplitterStream();
      stream = tts.stream(splitter, { voice: cfg.voice, speed: cfg.speed });
    },
    cancel() {
      cancelled = true;
      try { splitter.close(); } catch {}
    },
    async close() {
      cancelled = true;
      try { splitter.close(); } catch {}
    },
    iterator,
    get sampleRate() { return sampleRate; },
    get voice() { return cfg.voice; },
    get modelId() { return cfg.modelId; },
  };
}

export function float32ToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let s = src[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = (s * 0x7fff) | 0;
  }
  return out;
}
