// Tier 4 provider: edge-tts (Microsoft Edge Read-Aloud).
//
// Why msedge-tts: single ~10 kB pure-JS package, no API key, exposes a
// streaming WebSocket interface that emits MP3 chunks at 24 kHz mono. The
// alternatives (cloud Azure SDK, py-edge-tts subprocess) either require a
// key or a Python sidecar — both violate Tier 4's "in-process, no creds"
// contract.
//
// MP3 -> PCM: we decode with mpg123-decoder, a WASM streaming MPEG-1/2/3
// decoder. Picked over lamejs (encoder, not decoder) and node-lame (native
// ffmpeg dep). The decoder accepts arbitrary chunk boundaries and yields
// Float32Array channelData per call, so we can pump MP3 frames straight off
// the websocket without re-framing.
//
// Default voice = en-US-AriaNeural. Override with LAX_VOICE_EDGE_VOICE.
//
// Cancel/close semantics mirror the kokoro adapter: epoch counter to discard
// in-flight synth on barge-in. msedge-tts holds one ws per setMetadata call
// and exposes close() — we keep the connection warm across speak() calls and
// only tear it down in close().

import { Readable } from "node:stream";
import { createLogger } from "../../logger.js";
import { float32ToInt16 } from "./kokoro-engine.js";
import type {
  Tier4Callbacks,
  Tier4Config,
  Tier4StreamingTTS,
} from "./types.js";
import { TIER4_SAMPLE_RATE } from "./types.js";
import { EDGE_DEFAULT_VOICE } from "./edge-voices.js";

const logger = createLogger("voice.tier4.edge-tts");

// Lazy types: we don't want a hard import that crashes the host when
// msedge-tts isn't installed (parity with kokoro readiness flow).
type MsEdgeTTSCtor = new (opts?: { enableLogger?: boolean }) => MsEdgeTTSInstance;
interface MsEdgeTTSInstance {
  setMetadata(voiceName: string, outputFormat: string): Promise<void>;
  toStream(input: string, options?: { rate?: string; pitch?: string; volume?: string }): {
    audioStream: Readable;
    metadataStream: Readable | null;
  };
  close(): void;
}

type MPEGDecoderCtor = new (opts?: { enableGapless?: boolean }) => MPEGDecoderInstance;
interface MPEGDecoderInstance {
  ready: Promise<void>;
  reset(): Promise<void>;
  free(): void;
  decode(data: Uint8Array): {
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
    errors: unknown[];
  };
}

interface RuntimeState {
  tts: MsEdgeTTSInstance | null;
  decoder: MPEGDecoderInstance | null;
  queue: string[];
  draining: boolean;
  epoch: number;
  closed: boolean;
}

export function edgeTtsReadiness(): { ready: boolean; reason?: string } {
  try {
    // Avoid require.resolve here: tsconfig is module=Node16/ESM. A dynamic
    // import probe is too heavy for a sync readiness check, so we just guard
    // at construction time. Treat readiness as best-effort optimistic.
    return { ready: true };
  } catch (e) {
    return { ready: false, reason: (e as Error).message };
  }
}

export async function createEdgeTtsProvider(
  config: Tier4Config,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  // msedge-tts only accepts the short-name format (e.g. "en-US-AriaNeural")
  // and infers the locale via /\w{2}-\w{2}/ on the voice string. If a caller
  // hands us a long-name browser voice ("Microsoft Zira - English (United
  // States)") — which happens when a user switches tiers and the picker
  // carries over the previous tier's voice — the regex misses and the
  // adapter throws "Could not infer voiceLocale". Fall back to the curated
  // default instead of crashing.
  const requested = process.env.LAX_VOICE_EDGE_VOICE?.trim() || config.voice || EDGE_DEFAULT_VOICE;
  const voice = /\w{2}-\w{2}/.test(requested) ? requested : EDGE_DEFAULT_VOICE;
  if (voice !== requested) {
    logger.warn("edge-tts voice not in short-name format; falling back to default", { requested, fallback: voice });
  }

  let MsEdgeTTSMod: { MsEdgeTTS: MsEdgeTTSCtor; OUTPUT_FORMAT: Record<string, string> };
  try {
    MsEdgeTTSMod = (await import("msedge-tts")) as unknown as {
      MsEdgeTTS: MsEdgeTTSCtor;
      OUTPUT_FORMAT: Record<string, string>;
    };
  } catch (e) {
    throw new Error(`tier4 edge-tts: msedge-tts not installed (${(e as Error).message})`);
  }

  let MPEGDecoderMod: { MPEGDecoder: MPEGDecoderCtor };
  try {
    MPEGDecoderMod = (await import("mpg123-decoder")) as unknown as { MPEGDecoder: MPEGDecoderCtor };
  } catch (e) {
    throw new Error(`tier4 edge-tts: mpg123-decoder not installed (${(e as Error).message})`);
  }

  const tts = new MsEdgeTTSMod.MsEdgeTTS({ enableLogger: false });
  // 24 kHz mono MP3 matches Tier4 sample rate exactly — no resampling needed.
  const outputFormat =
    MPEGDecoderMod && MsEdgeTTSMod.OUTPUT_FORMAT
      ? MsEdgeTTSMod.OUTPUT_FORMAT["AUDIO_24KHZ_48KBITRATE_MONO_MP3"]
      : "audio-24khz-48kbitrate-mono-mp3";
  await tts.setMetadata(voice, outputFormat);

  const decoder = new MPEGDecoderMod.MPEGDecoder();
  await decoder.ready;

  const state: RuntimeState = {
    tts,
    decoder,
    queue: [],
    draining: false,
    epoch: 0,
    closed: false,
  };

  function pumpDecodedChunk(chunk: Uint8Array, startEpoch: number): void {
    if (!state.decoder) return;
    const decoded = state.decoder.decode(chunk);
    if (state.epoch !== startEpoch || state.closed) return;
    if (decoded.samplesDecoded <= 0) return;
    const ch = decoded.channelData[0];
    if (!ch || ch.length === 0) return;
    const pcm = float32ToInt16(ch);
    const sr = decoded.sampleRate || TIER4_SAMPLE_RATE;
    try { cb.onAudio?.(pcm, sr); } catch (e) { cb.onError?.(e as Error); }
  }

  async function synthOne(text: string): Promise<void> {
    if (!state.tts) return;
    const startEpoch = state.epoch;
    let stream: Readable;
    try {
      const r = state.tts.toStream(text);
      stream = r.audioStream;
    } catch (e) {
      cb.onError?.(e as Error);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.on("data", (buf: Buffer) => {
        if (state.epoch !== startEpoch || state.closed) return;
        try {
          pumpDecodedChunk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), startEpoch);
        } catch (e) {
          cb.onError?.(e as Error);
        }
      });
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", (err: Error) => {
        cb.onError?.(err);
        finish();
      });
    });
    if (state.epoch === startEpoch && !state.closed) {
      try { cb.onSentenceEnd?.(text); } catch (e) { cb.onError?.(e as Error); }
    }
  }

  async function drain(): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.queue.length > 0 && !state.closed) {
        const text = state.queue.shift()!;
        try {
          await synthOne(text);
        } catch (e) {
          cb.onError?.(e as Error);
        }
      }
      if (!state.closed) {
        try { cb.onIdle?.(); } catch (e) { cb.onError?.(e as Error); }
      }
    } finally {
      state.draining = false;
    }
  }

  logger.info("edge-tts ready", { voice, format: outputFormat });

  // Mutable so setVoice() can swap mid-session. The getter below reflects
  // the live value so voice-session can log the actual voice in use.
  let activeVoice = voice;

  const adapter: Tier4StreamingTTS = {
    speak(text: string) {
      if (state.closed) return;
      const t = text.trim();
      if (!t) return;
      state.queue.push(t);
      void drain();
    },
    cancel() {
      state.epoch++;
      state.queue.length = 0;
      // Reset decoder so partial MP3 frames from cancelled sentence don't
      // bleed into the next one.
      void state.decoder?.reset().catch(() => {});
    },
    close() {
      state.closed = true;
      state.epoch++;
      state.queue.length = 0;
      try { state.tts?.close(); } catch { /* ws may already be closed */ }
      try { state.decoder?.free(); } catch { /* idempotent */ }
      state.tts = null;
      state.decoder = null;
    },
    async setVoice(newVoice: string): Promise<void> {
      if (state.closed || !state.tts) return;
      // Same regex msedge-tts uses internally; reject names it can't
      // resolve (e.g. browser-style "Microsoft Zira - English (US)") to
      // avoid throwing inside the live session.
      if (!/\w{2}-\w{2}/.test(newVoice)) {
        logger.warn("edge-tts setVoice ignored — bad short-name format", { newVoice });
        return;
      }
      if (newVoice === activeVoice) return;
      try {
        await state.tts.setMetadata(newVoice, outputFormat);
        activeVoice = newVoice;
        logger.info("edge-tts voice swapped", { voice: newVoice });
      } catch (e) {
        logger.warn("edge-tts setVoice failed", { newVoice, err: (e as Error).message });
      }
    },
    get sampleRate() { return TIER4_SAMPLE_RATE; },
    get voice() { return activeVoice; },
    get runtime() {
      // edge-tts is a cloud websocket, so device/dtype don't apply. Report
      // cpu+q8 to keep the runtime field shape stable for voice-session.
      return { device: "cpu" as const, dtype: "q8" as const, fellBack: false };
    },
  };

  return adapter;
}
