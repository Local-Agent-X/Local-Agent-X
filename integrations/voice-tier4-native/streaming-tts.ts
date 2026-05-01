// Adapter: KokoroEngine → SAX Tier4StreamingTTS contract.
//
// SAX's existing voice-session.ts pulls TTS through a tight `speak/cancel/
// close` API with `onAudio/onSentenceEnd/onIdle/onError` callbacks. The
// kokoro-js API is generator-shaped instead. This file bridges the two:
// pump the engine's async iterator on a microtask loop, fire `onAudio`
// per chunk, fire `onSentenceEnd` between chunks, and fire `onIdle` when
// the queue drains.
//
// Cancel responsiveness is the tricky bit. kokoro-js does work in the main
// thread (the WebGPU/WASM call doesn't yield mid-inference), so cancel()
// can't preempt the *current* chunk. We mark a flag and short-circuit
// before the next chunk lands — same approach as tts-worker.ts.

import { createKokoroEngine, float32ToInt16 } from "./kokoro-engine.js";
import type { KokoroEngine } from "./kokoro-engine.js";
import type {
  Tier4Callbacks,
  Tier4Config,
  Tier4DiagSnapshot,
  Tier4StreamingTTS,
} from "./types.js";
import { TIER4_DEFAULTS } from "./types.js";

interface RuntimeState {
  engine: KokoroEngine | null;
  pumping: boolean;
  cancelled: boolean;
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
    pumping: false,
    cancelled: false,
    closed: false,
    speakTs: null,
    diag: {
      modelId: cfg.modelId,
      dtype: cfg.dtype,
      device: cfg.device,
      loadMs: 0,
      firstAudioMs: null,
      totalSentences: 0,
      cancelledSentences: 0,
    },
  };

  state.engine = await createKokoroEngine({
    config: cfg,
    onLoad: (ms) => { state.diag.loadMs = ms; },
  });

  async function pump(): Promise<void> {
    if (!state.engine || state.pumping) return;
    state.pumping = true;
    try {
      for await (const chunk of state.engine.iterator()) {
        if (state.cancelled || state.closed) {
          state.diag.cancelledSentences++;
          break;
        }
        if (state.diag.firstAudioMs == null && state.speakTs != null) {
          state.diag.firstAudioMs = Date.now() - state.speakTs;
        }
        const pcm = float32ToInt16(chunk.audio.audio);
        const sr = chunk.audio.sampling_rate || state.engine.sampleRate;
        try { cb.onAudio?.(pcm, sr); } catch (e) { cb.onError?.(e as Error); }
        if (chunk.text) {
          state.diag.totalSentences++;
          try { cb.onSentenceEnd?.(chunk.text); } catch (e) { cb.onError?.(e as Error); }
        }
      }
      if (!state.cancelled) cb.onIdle?.();
    } catch (e) {
      cb.onError?.(e as Error);
    } finally {
      state.pumping = false;
    }
  }

  return {
    speak(text: string) {
      if (state.closed || !state.engine) return;
      if (state.cancelled) state.cancelled = false;
      if (state.speakTs == null) state.speakTs = Date.now();
      state.engine.push(text);
      void pump();
    },
    cancel() {
      state.cancelled = true;
      state.speakTs = null;
      state.diag.firstAudioMs = null;
      state.engine?.cancel();
    },
    close() {
      state.closed = true;
      state.cancelled = true;
      void state.engine?.close();
    },
    get sampleRate() { return state.engine?.sampleRate ?? 24000; },
    get voice() { return cfg.voice; },
  };
}

export function snapshotTier4Diag(tts: Tier4StreamingTTS): Tier4DiagSnapshot | null {
  const internal = (tts as unknown as { __diag?: Tier4DiagSnapshot }).__diag;
  return internal ?? null;
}
