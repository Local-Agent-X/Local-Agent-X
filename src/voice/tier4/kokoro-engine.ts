// Kokoro-82M engine wrapper.
//
// kokoro-js bundles @huggingface/transformers + phonemizer and ships a
// `KokoroTTS` class. The rest of SAX speaks one-sentence-in / one-PCM-out
// (see src/voice/tts-stream.ts), so this wrapper exposes that exact shape:
// `synth(text)` returns a single PCM frame for the whole utterance. We do
// NOT use kokoro's TextSplitterStream because the orchestrator already chunks
// by sentence — feeding it our pre-split sentence one-shot is simpler, easier
// to cancel, and within the latency budget for short clauses on the 3060.

import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";
import type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";
import { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";

type RawAudio = { audio: Float32Array; sampling_rate: number };

type KokoroTTSInstance = {
  generate(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
};

type KokoroTTSCtor = {
  from_pretrained(
    modelId: string,
    opts: { dtype: Tier4Dtype; device: Tier4Device },
  ): Promise<KokoroTTSInstance>;
};

export interface KokoroEngine {
  synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
  close(): Promise<void>;
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

  const status = tier4ModelStatus(cfg.modelId);
  if (!status.cached && process.env.LAX_VOICE_DEBUG) {
    console.log(`[tier4/kokoro] cold start — first run will download to ${status.cacheDir}`);
  }

  const t0 = Date.now();
  const mod = (await import("kokoro-js")) as unknown as { KokoroTTS: KokoroTTSCtor };
  const tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, {
    dtype: cfg.dtype,
    device: cfg.device,
  });
  const loadMs = Date.now() - t0;
  init.onLoad?.(loadMs);

  let closed = false;

  return {
    async synth(text: string, opts?: { voice?: string; speed?: number }) {
      if (closed) throw new Error("kokoro engine closed");
      return tts.generate(text, {
        voice: opts?.voice ?? cfg.voice,
        speed: opts?.speed ?? cfg.speed,
      });
    },
    async close() { closed = true; },
    get sampleRate() { return TIER4_SAMPLE_RATE; },
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
