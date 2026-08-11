// KittenTTS 0.1 nano engine wrapper — no-Python, pure JS.
//
// KittenTTS is a StyleTTS2 model (config model_type=style_text_to_speech_2),
// the SAME transformers.js class + espeak-ng g2p Kokoro uses. It runs through
// @huggingface/transformers + phonemizer + onnxruntime-node (all already
// dependencies via the Kokoro path) — ~23 MB q8 ONNX, ~15M params, 24 kHz out.
//
// We expose the exact { synth, close, sampleRate, voice, modelId, runtime }
// shape kokoro-engine.ts does so the shared streaming adapter (streaming-tts.ts)
// drives either engine through one code path — see tier4-factory.ts.
//
// Pipeline (mirrors kokoro-js's generate_from_ids):
//   text --normalize + espeak g2p (kitten-phonemize)--> IPA string
//        --AutoTokenizer (IPA-char vocab)--> input_ids  [1, N]
//        + style vector [1,256] from voices/<name>.bin (256 float32)
//        + speed [1]
//        --StyleTextToSpeech2Model--> { waveform } @ 24 kHz
//
// Difference from Kokoro: Kitten voice .bin files are exactly 1024 bytes = 256
// float32 = ONE style vector (no per-length lookup table). So the whole bin is
// the style; no length-indexed slicing. Kitten is cpu+q8 only (no GPU EP path),
// so `runtime` always reports cpu and never falls back.

import { configureHFCache, tier4ModelStatus } from "./voice-clone-loader.js";
import { phonemizeKitten } from "./kitten-phonemize.js";
import { KITTEN_DEFAULT_VOICE, isValidKittenVoice } from "./kitten-voices.js";
import type { Tier4Config, Tier4Device, Tier4Dtype } from "./types.js";
import { TIER4_SAMPLE_RATE } from "./types.js";

export const KITTEN_MODEL_ID = "onnx-community/kitten-tts-nano-0.1-ONNX";

type RawAudio = { audio: Float32Array; sampling_rate: number };

// Narrow structural view of the transformers.js pieces we use, so this module
// doesn't depend on the package's full type surface (loaded lazily below).
interface Transformers {
  StyleTextToSpeech2Model: {
    from_pretrained(id: string, o: { dtype: string; device: string }): Promise<TtsModel>;
  };
  AutoTokenizer: { from_pretrained(id: string): Promise<Tokenizer> };
  Tensor: new (type: string, data: ArrayLike<number>, dims: number[]) => unknown;
  env: { cacheDir?: string; allowLocalModels?: boolean };
}
type TtsModel = (inputs: unknown) => Promise<{ waveform: { data: Float32Array } }>;
type Tokenizer = (text: string, opts: { truncation: boolean }) => { input_ids: unknown };

export interface KittenEngine {
  synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio>;
  close(): Promise<void>;
  readonly sampleRate: number;
  readonly voice: string;
  readonly modelId: string;
  readonly runtime: { device: Tier4Device; dtype: Tier4Dtype; fellBack: boolean };
}

export interface KittenEngineInit {
  config: Tier4Config;
  onLoad?: (ms: number) => void;
}

// Cache the 1 KB voice bin next to the model cache so repeat runs are offline.
async function loadVoiceStyle(name: string, cacheDir: string): Promise<Float32Array> {
  const { join } = await import("node:path");
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const dir = join(cacheDir, "kitten-voices");
  const path = join(dir, `${name}.bin`);
  try {
    const buf = await readFile(path);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch { /* not cached yet — fetch from the model repo */ }
  const url = `https://huggingface.co/${KITTEN_MODEL_ID}/resolve/main/voices/${name}.bin`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kitten: failed to fetch voice "${name}" (${res.status})`);
  const ab = await res.arrayBuffer();
  await mkdir(dir, { recursive: true });
  await writeFile(path, Buffer.from(ab));
  return new Float32Array(ab);
}

export async function createKittenEngine(init: KittenEngineInit): Promise<KittenEngine> {
  // Kitten owns a fixed model id and its own voice catalog. The incoming
  // config may still carry Kokoro's defaults (am_michael / Kokoro model id)
  // from TIER4_DEFAULTS when the user only picked the provider — so we ignore
  // the config modelId and validate voice against the Kitten set.
  const dtype: Tier4Dtype = init.config.dtype ?? "q8";
  const voice = isValidKittenVoice(init.config.voice) ? init.config.voice! : KITTEN_DEFAULT_VOICE;

  configureHFCache();
  const cacheDir = tier4ModelStatus(KITTEN_MODEL_ID).cacheDir;

  const status = tier4ModelStatus(KITTEN_MODEL_ID);
  if (!status.cached && process.env.LAX_VOICE_DEBUG) {
    console.log(`[tier4/kitten] cold start - first run will download to ${status.cacheDir}`);
  }

  const t0 = Date.now();
  const transformers = (await import("@huggingface/transformers")) as unknown as Transformers;
  const { phonemize } = (await import("phonemizer")) as unknown as {
    phonemize: (text: string, lang: string) => Promise<string[]>;
  };
  const { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } = transformers;
  // Point transformers.js at our cache dir before loading.
  env.cacheDir = cacheDir;

  const [model, tokenizer, defaultStyle] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(KITTEN_MODEL_ID, { dtype, device: "cpu" }),
    AutoTokenizer.from_pretrained(KITTEN_MODEL_ID),
    loadVoiceStyle(voice, cacheDir),
  ]);
  init.onLoad?.(Date.now() - t0);

  const styleCache = new Map<string, Float32Array>([[voice, defaultStyle]]);
  let closed = false;

  return {
    async synth(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudio> {
      if (closed) throw new Error("kitten engine closed");
      const v = isValidKittenVoice(opts?.voice) ? opts!.voice! : voice;
      let style = styleCache.get(v);
      if (!style) { style = await loadVoiceStyle(v, cacheDir); styleCache.set(v, style); }
      const ph = await phonemizeKitten(text, phonemize);
      const { input_ids } = tokenizer(ph, { truncation: true });
      const { waveform } = await model({
        input_ids,
        style: new Tensor("float32", style, [1, style.length]),
        speed: new Tensor("float32", [opts?.speed ?? init.config.speed ?? 1], [1]),
      });
      return { audio: waveform.data, sampling_rate: TIER4_SAMPLE_RATE };
    },
    async close() { closed = true; },
    get sampleRate() { return TIER4_SAMPLE_RATE; },
    get voice() { return voice; },
    get modelId() { return KITTEN_MODEL_ID; },
    // Kitten runs cpu+q8 only; no GPU EP to fall back from.
    get runtime() { return { device: "cpu" as Tier4Device, dtype, fellBack: false }; },
  };
}

// Re-export so callers that only pull kitten don't need kokoro-engine too.
export { float32ToInt16 } from "./kokoro-engine.js";
