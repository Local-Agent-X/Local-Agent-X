// Streaming Speech-to-Text.
//
// Wraps sherpa-onnx's OnlineRecognizer (a Zipformer2 transducer in streaming
// mode) behind a clean async API. Audio in, partial + final transcripts out.
//
// Streaming semantics:
//   - feedAudio(Int16Array @ 16kHz) buffers samples into the recognizer
//   - Every time enough audio is ready, we run a decode step
//   - partial() fires with the best-so-far hypothesis (may still change)
//   - When the recognizer says it's an endpoint (silence gap), we call
//     final() with the locked-in transcript and reset the decoder for the
//     next utterance
//
// The recognizer runs synchronously on the main thread. For a personal agent
// this is fine — the 16kHz audio stream takes well under 1% of a CPU core
// on a modern laptop. If that ever becomes a concern we can move it to a
// worker_thread without changing the public API.

import { createRequire } from "node:module";
import type { ModelPaths } from "./stt-model-fetch.js";

// sherpa-onnx is a CommonJS native addon. SAX itself runs as ESM ("type":
// "module"), so the bare `require` identifier doesn't exist at runtime —
// we synthesize one via createRequire. This also keeps the load lazy so
// voice-off users never pay the ~native addon init cost.
const requireCJS = createRequire(import.meta.url);

export type STTCallback = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
};

export interface StreamingSTT {
  /** Feed a frame of 16kHz Int16 PCM. Safe to call with any size. */
  feedAudio(pcm: Int16Array): void;
  /** Signal end-of-utterance from outside (optional — the recognizer also
   *  detects silence endpoints on its own). */
  flush(): void;
  /** Dispose the stream. Any pending partial is emitted as final. */
  close(): void;
}

interface SherpaRecognizer {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { text: string } | string;
  isEndpoint(stream: SherpaStream): boolean;
  reset(stream: SherpaStream): void;
  free(): void;
}

interface SherpaStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished?(): void;
  free?(): void;
}

/**
 * Build a streaming STT session. The model must already be downloaded —
 * call ensureModelDownloaded() from stt-model-fetch.ts first.
 */
export function createStreamingSTT(paths: ModelPaths, cb: STTCallback = {}): StreamingSTT {
  const sherpa = requireCJS("sherpa-onnx") as {
    createOnlineRecognizer: (config: unknown) => SherpaRecognizer;
  };

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      tokens: paths.tokens,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
      modelType: "zipformer2",
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    enableEndpoint: 1, // sherpa-onnx writes this as i32; keep as 0/1 not true/false
    // VAD drives endpoint detection at ~800ms silence. These rules are
    // pure fallback for when VAD misbehaves (e.g. model load failure).
    // Kept loose so they don't race VAD and fragment utterances mid-pause.
    rule1MinTrailingSilence: 1.8,
    rule2MinTrailingSilence: 1.0,
    rule3MinUtteranceLength: 20,
    hotwordsFile: "",
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: "", maxActive: 3000 },
    ruleFsts: "",
    ruleFars: "",
  };

  let recognizer: SherpaRecognizer;
  let stream: SherpaStream;
  let lastPartial = "";
  let closed = false;

  try {
    recognizer = sherpa.createOnlineRecognizer(config);
    stream = recognizer.createStream();
  } catch (e) {
    throw new Error(`sherpa-onnx init failed: ${(e as Error).message}`);
  }

  function extractText(result: { text: string } | string): string {
    if (typeof result === "string") return result;
    return result?.text || "";
  }

  function tick(): void {
    if (closed) return;
    try {
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const text = extractText(recognizer.getResult(stream)).trim();
      if (text !== lastPartial && text.length > 0) {
        lastPartial = text;
        cb.onPartial?.(text);
      }
      if (recognizer.isEndpoint(stream)) {
        const finalText = text;
        if (finalText.length > 0) cb.onFinal?.(finalText);
        recognizer.reset(stream);
        lastPartial = "";
      }
    } catch (e) {
      cb.onError?.(e as Error);
    }
  }

  return {
    feedAudio(pcm: Int16Array) {
      if (closed) return;
      // Convert Int16 → Float32 normalized to [-1, 1]
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
      try {
        stream.acceptWaveform(16000, samples);
        tick();
      } catch (e) {
        cb.onError?.(e as Error);
      }
    },

    flush() {
      if (closed) return;
      try {
        // Force a decode even if the buffer isn't full — emits whatever we have
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        const text = extractText(recognizer.getResult(stream)).trim();
        if (text.length > 0) cb.onFinal?.(text);
        recognizer.reset(stream);
        lastPartial = "";
      } catch (e) {
        cb.onError?.(e as Error);
      }
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        const text = extractText(recognizer.getResult(stream)).trim();
        if (text.length > 0 && text !== lastPartial) cb.onFinal?.(text);
      } catch { /* ignore cleanup errors */ }
      try { stream.free?.(); } catch {}
      try { recognizer.free(); } catch {}
    },
  };
}
