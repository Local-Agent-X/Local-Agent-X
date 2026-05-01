// Offline Whisper wrapper for utterance-level post-correction.
//
// Zipformer streaming STT gives us live partials with low WER-vs-latency
// tradeoff but ~10-12% word errors on conversational speech. Whisper
// tiny.en gets ~5-7% WER — we invoke it once per utterance (between VAD
// speech-start and speech-end) to produce the authoritative final
// transcript that the agent acts on.
//
// Whisper is synchronous: acceptWaveform + decode blocks the Node event
// loop for ~150-300ms per utterance on CPU. We serialize via a promise
// chain so the mic keeps flowing while one job finishes before the next
// starts; concurrent jobs would corrupt the internal stream state.
//
// GPU opt-in: defaults to provider:cpu. Users opt into CUDA/DirectML via
// LAX_VOICE_WHISPER_DEVICE. If the GPU EP fails to bind we fall back to
// cpu once so the user still gets transcripts.

import { createRequire } from "node:module";
import type { WhisperModelPaths } from "./whisper-model-fetch.js";

const requireCJS = createRequire(import.meta.url);

export type WhisperProvider = "cpu" | "cuda" | "dml" | "coreml";

export const VALID_WHISPER_PROVIDERS: ReadonlySet<WhisperProvider> = new Set<WhisperProvider>([
  "cpu", "cuda", "dml", "coreml",
]);

export const DEFAULT_WHISPER_PROVIDER: WhisperProvider = "cpu";

function normalizeProvider(v: unknown): WhisperProvider | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim().toLowerCase();
  if (!trimmed) return undefined;
  return VALID_WHISPER_PROVIDERS.has(trimmed as WhisperProvider)
    ? (trimmed as WhisperProvider)
    : undefined;
}

export interface WhisperTranscriberOptions {
  /** Override the ONNX execution provider. Falls back to env, then "cpu". */
  provider?: WhisperProvider;
}

/**
 * Pick the requested execution provider with caller > env > default
 * precedence. Mirrors `resolveWhisperVariant` in whisper-model-fetch.ts so
 * both knobs share the same shape (trim+lowercase+validate, invalid values
 * fall through silently). The returned value is what the caller should
 * try first; fallback to cpu on actual init failure is handled by
 * `createWhisperTranscriber`.
 */
export function resolveWhisperProvider(
  opts: WhisperTranscriberOptions = {},
): WhisperProvider {
  return normalizeProvider(opts.provider)
    ?? normalizeProvider(process.env.LAX_VOICE_WHISPER_DEVICE)
    ?? DEFAULT_WHISPER_PROVIDER;
}

export interface WhisperTranscriber {
  /** Transcribe a completed utterance. Samples must be 16kHz Int16 mono. */
  transcribe(pcm: Int16Array): Promise<string>;
  close(): void;
  /** Active provider + whether we fell back from a GPU EP. */
  readonly runtime: { provider: WhisperProvider; fellBack: boolean };
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

interface SherpaModule {
  createOfflineRecognizer: (config: unknown) => SherpaOfflineRecognizer;
}

function buildConfig(paths: WhisperModelPaths, provider: WhisperProvider): unknown {
  return {
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
      // Must be 1 on sherpa-onnx's WASM build (no SharedArrayBuffer/pthread
      // support). Setting > 1 throws an Emscripten exception pointer at
      // OfflineRecognizer init. For parallelism we'd need the native addon
      // build of sherpa-onnx.
      numThreads: 1,
      provider,
      debug: 0,
      modelType: "whisper",
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
  };
}

export function createWhisperTranscriber(
  paths: WhisperModelPaths,
  opts: WhisperTranscriberOptions = {},
): WhisperTranscriber {
  const sherpa = requireCJS("sherpa-onnx") as SherpaModule;

  let activeProvider: WhisperProvider = resolveWhisperProvider(opts);
  let fellBack = false;
  let recognizer: SherpaOfflineRecognizer;
  try {
    recognizer = sherpa.createOfflineRecognizer(buildConfig(paths, activeProvider));
  } catch (e) {
    // GPU EP can fail at init (CUDA libs missing, DML kernel coverage gaps,
    // unsupported provider in this sherpa-onnx build). Fall back to CPU
    // once — the user still gets transcripts even on a misconfigured GPU
    // setup. CPU init failures bubble up untouched.
    if (activeProvider === "cpu") {
      throw new Error(`sherpa-onnx Whisper init failed: ${(e as Error).message}`);
    }
    if (process.env.LAX_VOICE_DEBUG) {
      console.warn(
        `[whisper] ${activeProvider} init failed (${(e as Error).message}); falling back to cpu`,
      );
    }
    activeProvider = "cpu";
    fellBack = true;
    try {
      recognizer = sherpa.createOfflineRecognizer(buildConfig(paths, activeProvider));
    } catch (e2) {
      throw new Error(`sherpa-onnx Whisper init failed: ${(e2 as Error).message}`);
    }
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

    get runtime() { return { provider: activeProvider, fellBack }; },
  };
}
