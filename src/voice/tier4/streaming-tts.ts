// Adapter: KokoroEngine → SAX StreamingTTS contract (see src/voice/tts-stream.ts).
//
// The orchestrator in src/voice/voice-session.ts calls `tts.speak(sentence)`
// per sentence and expects `onAudio(pcm, sampleRate)` callbacks plus an
// `onIdle()` once the queue drains. We mirror that shape exactly so the
// dispatcher in voice-session.ts is a single branch.
//
// Cancel semantics: barge-in bumps a monotonic epoch counter, clears
// the in-memory queue, and resets first-audio timing. kokoro-js
// .generate() is a single ORT forward pass that doesn't yield mid-call,
// so the in-flight synth still runs to completion. We snapshot the
// epoch before each await synth(); drop the result on resume if the
// epoch moved (cancelled or closed). A boolean flag is unsafe: a fresh
// speak() between cancel() and the in-flight synth resolution would
// reset it and leak the cancelled audio.

import { createKokoroEngine, float32ToInt16 } from "./kokoro-engine.js";
import type { KokoroEngine } from "./kokoro-engine.js";
import type {
  Tier4Callbacks,
  Tier4Config,
  Tier4DiagSnapshot,
  Tier4StreamingTTS,
} from "./types.js";
import { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";

interface RuntimeState {
  engine: KokoroEngine | null;
  queue: string[];
  draining: boolean;
  epoch: number;
  closed: boolean;
  diag: Tier4DiagSnapshot;
  speakTs: number | null;
}

export async function createTier4StreamingTTS(
  config: Tier4Config,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  const cfg = { ...TIER4_DEFAULTS, ...config };
  const state: RuntimeState = {
    engine: null,
    queue: [],
    draining: false,
    closed: false,
    epoch: 0,
    speakTs: null,
    diag: {
      modelId: cfg.modelId,
      dtype: cfg.dtype,
      device: cfg.device,
      loadMs: 0,
      firstAudioMs: null,
      totalSentences: 0,
      cancelledSentences: 0,
      fellBack: false,
    },
  };

  state.engine = await createKokoroEngine({
    config: cfg,
    onLoad: (ms) => { state.diag.loadMs = ms; },
  });
  // Engine may fall back to cpu+q8 if a GPU EP fails to bind. Reflect the
  // actual runtime in the diag so the UI / smoke test shows what loaded.
  state.diag.device = state.engine.runtime.device;
  state.diag.dtype = state.engine.runtime.dtype;
  state.diag.fellBack = state.engine.runtime.fellBack;

  async function drain(): Promise<void> {
    if (state.draining || !state.engine) return;
    state.draining = true;
    try {
      while (state.queue.length > 0 && !state.closed) {
        const text = state.queue.shift()!;
        const startEpoch = state.epoch;
        try {
          const audio = await state.engine.synth(text, { voice: cfg.voice, speed: cfg.speed });
          if (state.closed) break;
          if (state.epoch !== startEpoch) {
            state.diag.cancelledSentences++;
            continue;
          }
          if (state.diag.firstAudioMs == null && state.speakTs != null) {
            state.diag.firstAudioMs = Date.now() - state.speakTs;
          }
          const pcm = float32ToInt16(audio.audio);
          const sr = audio.sampling_rate || TIER4_SAMPLE_RATE;
          try { cb.onAudio?.(pcm, sr); } catch (e) { cb.onError?.(e as Error); }
          state.diag.totalSentences++;
          try { cb.onSentenceEnd?.(text); } catch (e) { cb.onError?.(e as Error); }
        } catch (e) {
          cb.onError?.(e as Error);
        }
      }
      if (!state.closed) {
        try { cb.onIdle?.(); } catch (e) { cb.onError?.(e as Error); }
      }
    } finally {
      state.draining = false;
      if (state.queue.length === 0) state.speakTs = null;
    }
  }

  const adapter: Tier4StreamingTTS & { __diag: Tier4DiagSnapshot } = {
    speak(text: string) {
      if (state.closed) return;
      const t = text.trim();
      if (!t) return;
      if (state.speakTs == null) state.speakTs = Date.now();
      state.queue.push(t);
      void drain();
    },
    cancel() {
      state.epoch++;
      state.queue.length = 0;
      state.speakTs = null;
      state.diag.firstAudioMs = null;
    },
    close() {
      state.closed = true;
      state.epoch++;
      state.queue.length = 0;
      void state.engine?.close();
    },
    get sampleRate() { return state.engine?.sampleRate ?? TIER4_SAMPLE_RATE; },
    get voice() { return cfg.voice; },
    get runtime() {
      return state.engine?.runtime ?? { device: cfg.device, dtype: cfg.dtype, fellBack: false };
    },
    __diag: state.diag,
  };

  return adapter;
}

export function snapshotTier4Diag(tts: Tier4StreamingTTS): Tier4DiagSnapshot | null {
  const internal = (tts as unknown as { __diag?: Tier4DiagSnapshot }).__diag;
  return internal ?? null;
}
