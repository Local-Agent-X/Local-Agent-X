// Streaming Text-to-Speech.
//
// Wraps sherpa-onnx's Matcha-icefall TTS. Sentences go in, Int16 PCM chunks
// come out progressively via a callback. The underlying synthesis is still
// per-sentence (Matcha's flow-matching is one-shot per utterance), but:
//   - sherpa-onnx emits intermediate chunks during generation
//   - we queue sentences and synthesize one at a time so time-to-first-audio
//     is "first-sentence-TTFT" not "full-response-TTFT"
//
// The WASM generate() call blocks the Node event loop while synthesizing
// (~0.3-0.6x real-time on CPU). For Phase 3 this is acceptable because a
// voice session has at most one active TTS stream. Phase 4 will move this
// to a worker_thread for interrupt-during-speech.

import { createRequire } from "node:module";
import type { TTSModelPaths } from "./tts-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

export type TTSCallback = {
  /** Fires as audio is generated. pcm is Int16 at the model's native rate. */
  onAudio?: (pcm: Int16Array, sampleRate: number) => void;
  /** Fires when a sentence finishes synthesizing. */
  onSentenceEnd?: (text: string) => void;
  /** Fires when the queue drains to empty. */
  onIdle?: () => void;
  onError?: (err: Error) => void;
};

export interface StreamingTTS {
  /** Queue a sentence (or fragment) for synthesis. Non-blocking. */
  speak(text: string): void;
  /** Current output sample rate (22050 for Matcha-icefall-ljspeech). */
  readonly sampleRate: number;
  /** Drop all queued sentences + the currently-synthesizing one. */
  cancel(): void;
  /** Dispose. */
  close(): void;
}

interface SherpaOfflineTts {
  sampleRate: number;
  numSpeakers: number;
  generateWithConfig(text: string, config: {
    sid?: number;
    speed?: number;
    callback?: (samples: Float32Array, n: number, progress: number) => number;
  }): { samples: Float32Array; sampleRate: number };
  free(): void;
}

export function createStreamingTTS(paths: TTSModelPaths, cb: TTSCallback = {}): StreamingTTS {
  const sherpa = requireCJS("sherpa-onnx") as {
    createOfflineTts: (config: unknown) => SherpaOfflineTts;
  };

  // sherpa-onnx reads fields on every model-family sub-config without
  // null-checks, so we must provide empty placeholders for the ones we
  // aren't using. Only the matcha block carries real paths.
  const emptyVits = { model: "", lexicon: "", tokens: "", dataDir: "", noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 };
  const emptyKokoro = { model: "", voices: "", tokens: "", dataDir: "", dictDir: "", lengthScale: 1.0, lexicon: "" };

  const config = {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: emptyVits,
      offlineTtsMatchaModelConfig: {
        acousticModel: paths.acousticModel,
        vocoder: paths.vocoder,
        tokens: paths.tokens,
        lexicon: "",
        dataDir: paths.dataDir, // espeak-ng-data — required for G2P on LJSpeech
        noiseScale: 0.667,
        lengthScale: 1.0,
      },
      offlineTtsKokoroModelConfig: emptyKokoro,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
    silenceScale: 0.2,
  };

  let tts: SherpaOfflineTts;
  try {
    tts = sherpa.createOfflineTts(config);
  } catch (e) {
    throw new Error(`sherpa-onnx TTS init failed: ${(e as Error).message}`);
  }

  const sampleRate = tts.sampleRate || paths.sampleRate;
  const queue: string[] = [];
  let draining = false;
  let cancelled = false;
  let closed = false;

  function floatToInt16(f32: Float32Array): Int16Array {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  async function drain(): Promise<void> {
    if (draining || closed) return;
    draining = true;
    try {
      while (queue.length > 0 && !closed) {
        if (cancelled) {
          cancelled = false;
          queue.length = 0;
          break;
        }
        const text = queue.shift()!;
        const localCancel = { stop: false };
        try {
          tts.generateWithConfig(text, {
            sid: 0,
            speed: 1.0,
            callback: (samples /*, n, progress */) => {
              if (closed || localCancel.stop || cancelled) return 0; // 0 = abort
              if (samples.length > 0) {
                cb.onAudio?.(floatToInt16(samples), sampleRate);
              }
              return 1; // 1 = continue
            },
          });
          if (!closed) cb.onSentenceEnd?.(text);
        } catch (e) {
          cb.onError?.(e as Error);
        }
        // Yield so queued WS writes can flush between sentences
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      draining = false;
      if (!closed && queue.length === 0) cb.onIdle?.();
    }
  }

  return {
    sampleRate,

    speak(text: string) {
      if (closed) return;
      const t = text.trim();
      if (!t) return;
      queue.push(t);
      if (!draining) drain();
    },

    cancel() {
      cancelled = true;
      queue.length = 0;
    },

    close() {
      if (closed) return;
      closed = true;
      cancelled = true;
      queue.length = 0;
      try { tts.free(); } catch {}
    },
  };
}
