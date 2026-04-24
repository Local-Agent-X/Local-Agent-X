// Offline Whisper wrapper for utterance-level post-correction.
//
// Zipformer streaming STT gives us live partials with low WER-vs-latency
// tradeoff but ~10-12% word errors on conversational speech. Whisper
// base.en gets ~5% WER — we invoke it once per utterance (between VAD
// speech-start and speech-end) to produce the authoritative final
// transcript that the agent acts on.
//
// Whisper is synchronous: acceptWaveform + decode blocks the Node event
// loop for ~200-400ms per utterance on CPU. We serialize via a promise
// chain so the mic keeps flowing while one job finishes before the next
// starts; concurrent jobs would corrupt the internal stream state.

import { createRequire } from "node:module";
import type { WhisperModelPaths } from "./whisper-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

export interface WhisperTranscriber {
  /** Transcribe a completed utterance. Samples must be 16kHz Int16 mono. */
  transcribe(pcm: Int16Array): Promise<string>;
  close(): void;
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  getResult(stream: SherpaOfflineStream): { text: string } | string;
  free(): void;
}

interface SherpaOfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}

export function createWhisperTranscriber(paths: WhisperModelPaths): WhisperTranscriber {
  const sherpa = requireCJS("sherpa-onnx") as {
    createOfflineRecognizer: (config: unknown) => SherpaOfflineRecognizer;
  };

  const config = {
    modelConfig: {
      whisper: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        language: "en",
        task: "transcribe",
        tailPaddings: 2000,
        enableTokenTimestamps: 0,
        enableSegmentTimestamps: 0,
      },
      tokens: paths.tokens,
      numThreads: 2, // Whisper decode is the bottleneck; 2 threads ~= 1.6x speedup
      provider: "cpu",
      debug: 0,
      modelType: "whisper",
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
  };

  let recognizer: SherpaOfflineRecognizer;
  try {
    recognizer = sherpa.createOfflineRecognizer(config);
  } catch (e) {
    throw new Error(`sherpa-onnx Whisper init failed: ${(e as Error).message}`);
  }

  let closed = false;
  // Serialize jobs — running two decodes concurrently corrupts the
  // internal wasm state because they share one Module.
  let jobChain: Promise<void> = Promise.resolve();

  return {
    transcribe(pcm: Int16Array): Promise<string> {
      if (closed) return Promise.resolve("");

      const job = jobChain.then(async () => {
        if (closed) return "";
        // Int16 → Float32 normalized to [-1, 1]
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;

        let stream: SherpaOfflineStream | null = null;
        try {
          stream = recognizer.createStream();
          stream.acceptWaveform(16000, samples);
          recognizer.decode(stream);
          const r = recognizer.getResult(stream);
          const text = typeof r === "string" ? r : (r?.text || "");
          return text.trim();
        } finally {
          try { stream?.free(); } catch {}
        }
      });

      jobChain = job.then(() => undefined, () => undefined);
      return job;
    },

    close() {
      if (closed) return;
      closed = true;
      try { recognizer.free(); } catch {}
    },
  };
}
