// Chatterbox-multilingual cloning path — SCAFFOLDING ONLY.
//
// Why this isn't a v1 fast path:
//   * 4 ONNX graphs (~12 GB total) — embed_tokens, language_model,
//     speech_encoder, conditional_decoder.
//   * Decoder is autoregressive on a 0.5B Llama backbone. We'd need a
//     hand-rolled KV-cache loop in TS using onnxruntime-node sessions.
//     Realistically that's 2-3+ s to first audio even on a 3060, which
//     blows the <500 ms target.
//   * Better path: keep cloning behind LAX_VOICE_CLONE_REF for users who
//     accept higher latency in exchange for voice match.
//
// What this file does provide:
//   * Typed contract that matches Tier4StreamingTTS so the factory can
//     dispatch to it without runtime branching at the orchestrator.
//   * Outline of the inference loop in TODO comments — the next person
//     can fill in the ort sessions without re-doing the architecture.
//
// What it doesn't do: load weights, run inference, or produce audio.
// Calling it returns a stub that emits onError once and stays idle.

import { loadReferenceWav24kMono } from "./voice-clone-loader.js";
import type {
  Tier4Callbacks,
  Tier4Config,
  Tier4StreamingTTS,
} from "./types.js";

export interface ChatterboxCloneOptions extends Tier4Config {
  referenceWavPath?: string;
}

export async function createChatterboxClonePath(
  opts: ChatterboxCloneOptions,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  // Step 1 — sanity check on reference clip. We do this eagerly so the user
  // gets a fast fail rather than a 12 GB download followed by a "no ref" err.
  const refPath = opts.referenceWavPath || process.env.LAX_VOICE_CLONE_REF;
  if (!refPath) {
    queueMicrotask(() => {
      cb.onError?.(new Error(
        "tier4 chatterbox-clone: missing reference WAV. " +
        "Set LAX_VOICE_CLONE_REF or pass referenceWavPath.",
      ));
    });
    return inertTTS(opts);
  }

  let refSamples: Float32Array;
  try {
    refSamples = loadReferenceWav24kMono(refPath);
  } catch (err) {
    queueMicrotask(() => cb.onError?.(err as Error));
    return inertTTS(opts);
  }
  if (refSamples.length < 24000 * 5) {
    queueMicrotask(() => cb.onError?.(new Error(
      "tier4 chatterbox-clone: reference WAV must be >=5s of 24kHz mono PCM",
    )));
    return inertTTS(opts);
  }

  // TODO(tier5): real inference loop. Sketch:
  //   const ort = await import("onnxruntime-node");
  //   const sessOpt = { executionProviders: [opts.device === "dml" ? "dml" : "cpu"] };
  //   const embed = await ort.InferenceSession.create(embedTokensPath, sessOpt);
  //   const lm = await ort.InferenceSession.create(languageModelPath, sessOpt);
  //   const enc = await ort.InferenceSession.create(speechEncoderPath, sessOpt);
  //   const dec = await ort.InferenceSession.create(conditionalDecoderPath, sessOpt);
  //   const speakerEmbed = await enc.run({ wav: tensor(refSamples, [1, n]) });
  //   for each token: lm.run({ ids, kv_cache_in }) → next_id, kv_cache_out
  //   accumulate token ids → dec.run({ ids, speaker_embed }) → mel → vocoder → pcm
  //   yield Int16Array chunk via cb.onAudio

  queueMicrotask(() => cb.onError?.(new Error(
    "tier4 chatterbox-clone: inference path not implemented in v1. " +
    `(reference loaded ok: ${refSamples.length} samples)`,
  )));
  return inertTTS(opts);
}

function inertTTS(opts: Tier4Config): Tier4StreamingTTS {
  return {
    speak() {},
    cancel() {},
    close() {},
    sampleRate: 24000,
    voice: opts.voice ?? "clone",
  };
}
