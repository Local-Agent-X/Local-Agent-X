// Kokoro-82M engine wrapper.
//
// kokoro-js bundles @huggingface/transformers + phonemizer and ships a
// `KokoroTTS` class. The rest of SAX speaks one-sentence-in / one-PCM-out
// (see src/voice/tts-stream.ts), so this wrapper exposes that exact shape:
// `synth(text)` returns a single PCM frame for the whole utterance. We do
// NOT use kokoro's TextSplitterStream because the orchestrator already chunks
// by sentence — feeding it our pre-split sentence one-shot is simpler, easier
// to cancel, and within the latency budget for short clauses on the 3060.
//
// GPU opt-in: defaults q8+cpu. Users opt into DirectML/CUDA/WebGPU via
// LAX_VOICE_TIER4_DEVICE plus optional LAX_VOICE_TIER4_DTYPE. If the GPU EP
// fails to bind we fall back to cpu+q8 so the user still gets audio.

import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";
import type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";
import { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";
import { envDevice, envDtype, envVoice, envSpeed } from "./env.js";

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
  readonly runtime: { device: Tier4Device; dtype: Tier4Dtype; fellBack: boolean };
}

export interface KokoroEngineInit {
  config: Tier4Config;
  onLoad?: (ms: number) => void;
}

export async function createKokoroEngine(init: KokoroEngineInit): Promise<KokoroEngine> {
  // Env vars override the static defaults; explicit init.config still wins
  // over env so callers (smoke test, gpu probe) can pin a device for tests.
  const envOverrides: Partial<Tier4Config> = {};
  const ed = envDevice(); if (ed) envOverrides.device = ed;
  const et = envDtype(); if (et) envOverrides.dtype = et;
  const ev = envVoice(); if (ev) envOverrides.voice = ev;
  const es = envSpeed(); if (es !== undefined) envOverrides.speed = es;
  const cfg = { ...TIER4_DEFAULTS, ...envOverrides, ...init.config };
  configureHFCache();

  const status = tier4ModelStatus(cfg.modelId);
  if (!status.cached && process.env.LAX_VOICE_DEBUG) {
    console.log(`[tier4/kokoro] cold start - first run will download to ${status.cacheDir}`);
  }

  const t0 = Date.now();
  const mod = (await import("kokoro-js")) as unknown as { KokoroTTS: KokoroTTSCtor };

  let activeDevice: Tier4Device = cfg.device;
  let activeDtype: Tier4Dtype = cfg.dtype;
  let fellBack = false;
  let tts: KokoroTTSInstance;
  try {
    tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, {
      dtype: activeDtype,
      device: activeDevice,
    });
  } catch (e) {
    // GPU EP can fail at init (DML kernel coverage gaps, missing CUDA libs,
    // WebGPU shader compile errors). Fall back to cpu+q8 once - this is the
    // combo we know works on every machine. CPU/wasm errors surface upward.
    const requestedNonCpu = activeDevice !== "cpu" && activeDevice !== "wasm";
    if (!requestedNonCpu) throw e;
    if (process.env.LAX_VOICE_DEBUG) {
      console.warn(
        `[tier4/kokoro] ${activeDevice}+${activeDtype} init failed (${(e as Error).message}); falling back to cpu+q8`,
      );
    }
    activeDevice = "cpu";
    activeDtype = "q8";
    fellBack = true;
    tts = await mod.KokoroTTS.from_pretrained(cfg.modelId, {
      dtype: activeDtype,
      device: activeDevice,
    });
  }
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
    get runtime() { return { device: activeDevice, dtype: activeDtype, fellBack }; },
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
