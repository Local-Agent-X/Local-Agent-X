// Streaming Voice Activity Detection.
//
// Wraps sherpa-onnx's Silero VAD. We don't care about sherpa's internal
// speech-segment buffering (STT handles transcription); we only need the
// rising/falling edges of the speech-detected flag so the orchestrator
// can:
//   • trigger endpoint fast (forces STT flush ~500ms after last speech,
//     vs sherpa's 1-2sec silence timers)
//   • detect barge-in (user talks while agent is replying → interrupt)
//
// The edges are emitted once per transition; callers keep their own state.

import { createRequire } from "node:module";
import type { VadModelPaths } from "./vad-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

export type VadCallback = {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (err: Error) => void;
};

export interface StreamingVAD {
  /** Feed 16kHz Int16 PCM. Safe with any frame length. */
  feedAudio(pcm: Int16Array): void;
  /** True iff speech is currently detected. */
  isSpeaking(): boolean;
  /** Drop internal buffers. Useful after a barge-in so old audio doesn't
   *  re-trigger speech detection on the next frame. */
  reset(): void;
  close(): void;
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  clear(): void;
  reset(): void;
  flush(): void;
  free(): void;
}

export function createStreamingVAD(paths: VadModelPaths, cb: VadCallback = {}): StreamingVAD {
  const sherpa = requireCJS("sherpa-onnx") as {
    createVad: (config: unknown) => SherpaVad;
  };

  // Silero-VAD runs at 16kHz with 512-sample windows (32ms). Thresholds
  // tuned for interactive voice chat — conservative enough not to
  // interrupt the agent on stray mic noise, fast enough to feel live.
  const config = {
    sileroVad: {
      model: paths.model,
      threshold: 0.55,           // slightly above default to reduce false triggers
      // 800ms tolerance for natural mid-sentence pauses (breath, thinking).
      // 500ms was cutting users mid-thought and fragmenting transcripts.
      // Still 3x faster than sherpa's default 2.4s silence timer.
      minSilenceDuration: 0.8,
      minSpeechDuration: 0.2,    // sec — ignore clicks/breaths shorter than this
      windowSize: 512,
      maxSpeechDuration: 20,
    },
    numThreads: 1,
    debug: 0,
    provider: "cpu",
    sampleRate: 16000,
  };

  let vad: SherpaVad;
  try {
    vad = sherpa.createVad(config);
  } catch (e) {
    throw new Error(`sherpa-onnx VAD init failed: ${(e as Error).message}`);
  }

  let speaking = false;
  let closed = false;

  // Scratch Float32 buffer reused across calls to avoid GC churn on every
  // 32ms mic frame.
  let scratch = new Float32Array(0);

  function ensureScratch(n: number): Float32Array {
    if (scratch.length < n) scratch = new Float32Array(n);
    return scratch;
  }

  return {
    feedAudio(pcm: Int16Array) {
      if (closed) return;
      try {
        const buf = ensureScratch(pcm.length);
        for (let i = 0; i < pcm.length; i++) buf[i] = pcm[i] / 0x8000;
        vad.acceptWaveform(buf.subarray(0, pcm.length));

        // Drain any complete speech segments sherpa queues internally — we
        // don't use them, but leaving them pinned leaks memory over time.
        while (!vad.isEmpty()) vad.pop();

        const nowSpeaking = vad.isDetected();
        if (nowSpeaking && !speaking) {
          speaking = true;
          cb.onSpeechStart?.();
        } else if (!nowSpeaking && speaking) {
          speaking = false;
          cb.onSpeechEnd?.();
        }
      } catch (e) {
        cb.onError?.(e as Error);
      }
    },

    isSpeaking() { return speaking; },

    reset() {
      if (closed) return;
      try {
        vad.reset();
        vad.clear();
      } catch {}
      if (speaking) {
        speaking = false;
        cb.onSpeechEnd?.();
      }
    },

    close() {
      if (closed) return;
      closed = true;
      try { vad.free(); } catch {}
    },
  };
}
