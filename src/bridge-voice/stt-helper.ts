// Bridge-side STT entry point.
//
// Wraps the existing voice/stt-providers stack so the Telegram and WhatsApp
// bridges can transcribe inbound voice notes without touching the realtime
// voice-session code path. We resolve the provider from
// LAX_VOICE_STT_PROVIDER (default "local-whisper"), download the model on
// first use for the local path, decode the OGG/Opus payload via ffmpeg,
// transcribe, and discard known Whisper hallucinations.
//
// All failure modes return null — callers fall back to the legacy
// "saved file path" placeholder so the bridge never silently drops a
// message.

import {
  createSttProvider,
  isWhisperHallucination,
  resolveSttProviderName,
  type SttProviderName,
} from "../voice/stt-providers/index.js";
import {
  ensureWhisperModelDownloaded,
  type WhisperModelPaths,
} from "../voice/whisper-model-fetch.js";
import type { WhisperTranscriber } from "../voice/whisper-stream.js";

import { decodeOggToPcm16, isFfmpegAvailable } from "./audio-codec.js";

import { createLogger } from "../logger.js";
const logger = createLogger("bridge-voice.stt");

// We re-use a single transcriber across calls for the local path — model
// load is expensive (50-280 MB ONNX into memory). Cloud providers are
// stateless so re-creating per call is fine, but we still memoize for
// symmetry.
let cachedProvider: WhisperTranscriber | null = null;
let cachedProviderName: SttProviderName | null = null;
let cachedLocalPaths: WhisperModelPaths | null = null;

async function getOrCreateProvider(): Promise<WhisperTranscriber | null> {
  const name: SttProviderName = resolveSttProviderName() || "local-whisper";

  if (cachedProvider && cachedProviderName === name) return cachedProvider;
  // Tear down the previous one if the env knob changed mid-run.
  if (cachedProvider) {
    try { cachedProvider.close(); } catch {}
    cachedProvider = null;
    cachedProviderName = null;
  }

  try {
    if (name === "local-whisper") {
      if (!cachedLocalPaths) {
        cachedLocalPaths = await ensureWhisperModelDownloaded();
      }
      cachedProvider = createSttProvider(name, { local: { paths: cachedLocalPaths } });
    } else {
      cachedProvider = createSttProvider(name, { cloud: {} });
    }
    cachedProviderName = name;
    logger.info(`STT provider ready: ${name}`);
    return cachedProvider;
  } catch (e) {
    logger.error(`STT provider init failed (${name}): ${(e as Error).message}`);
    return null;
  }
}

/**
 * Transcribe an OGG/Opus buffer. Returns null on any failure (ffmpeg
 * missing, model unavailable, network error, hallucination, empty input).
 * Callers must fall back to a non-voice handling path on null.
 */
export async function transcribeOggBuffer(buf: Buffer): Promise<string | null> {
  if (!buf || buf.length === 0) return null;

  if (!(await isFfmpegAvailable())) {
    logger.warn("ffmpeg not available — skipping transcription");
    return null;
  }

  let pcm: Int16Array;
  try {
    pcm = await decodeOggToPcm16(buf);
  } catch (e) {
    logger.error(`decode failed: ${(e as Error).message}`);
    return null;
  }

  // Empty / silence-only audio after decode.
  if (pcm.length < 1600) {
    logger.info(`audio too short (${pcm.length} samples) — skipping`);
    return null;
  }

  const provider = await getOrCreateProvider();
  if (!provider) return null;

  try {
    const text = await provider.transcribe(pcm);
    if (!text) return null;
    if (isWhisperHallucination(text)) {
      logger.info(`dropped hallucination: "${text.slice(0, 60)}"`);
      return null;
    }
    return text;
  } catch (e) {
    logger.error(`transcribe failed: ${(e as Error).message}`);
    return null;
  }
}
