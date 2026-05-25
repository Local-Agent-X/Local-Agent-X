// One-shot async initialization for the voice stack: download the four
// model bundles in parallel (STT / TTS / VAD / Whisper), then build the
// runtime engines per voiceSettings.
//
// Returns the engines + sample rate + runtime metadata so the
// orchestrator can wire callbacks and surface a `voice_ready` event.
// On failure, surfaces a `voice_error` via ctx and resolves with null.

import { createLogger } from "../../logger.js";
import type { VoiceSessionContext } from "../audio-ws.js";
import { createStreamingSTT, type StreamingSTT } from "../stt-stream.js";
import { ensureModelDownloaded, getModelPaths } from "../stt-model-fetch.js";
import { createStreamingTTS, type StreamingTTS } from "../tts-stream.js";
import { ensureTTSModelDownloaded, getTTSModelPaths } from "../tts-model-fetch.js";
import { createStreamingVAD, type StreamingVAD } from "../vad-stream.js";
import { ensureVadModelDownloaded, getVadModelPaths } from "../vad-model-fetch.js";
import {
  createWhisperTranscriber,
  type WhisperTranscriber,
} from "../whisper-stream.js";
import {
  ensureWhisperModelDownloaded,
  getWhisperModelPaths,
} from "../whisper-model-fetch.js";
import { createTier4, tier4VariantFromEnv } from "../tier4/index.js";
import { createSttProvider, resolveSttProviderName } from "../stt-providers/index.js";
import type { Tier4StreamingTTS } from "../tier4/types.js";
import type { ResolvedVoiceSettings } from "./settings.js";
import type { SecretLookup } from "./types.js";

const logger = createLogger("voice.voice-session");

export interface TtsCallbacks {
  onAudio: (pcm: Int16Array) => void;
  onIdle: () => void;
  onError: (err: Error) => void;
}

export interface StreamingSttCallbacks {
  onPartial: (text: string) => void;
  onError: (err: Error) => void;
}

export interface VadCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onError: (err: Error) => void;
}

export interface InitializedStack {
  stt: StreamingSTT | null;
  tts: StreamingTTS | null;
  vad: StreamingVAD | null;
  whisper: WhisperTranscriber | null;
  ttsSampleRate: number;
  ttsRuntime: unknown;
  sttRuntime: unknown;
}

export interface ModelInitDeps {
  ctx: VoiceSessionContext;
  voiceSettings: ResolvedVoiceSettings;
  engine: "tier4" | "python" | "cpu_fallback";
  getSecret: SecretLookup;
  ttsCallbacks: TtsCallbacks;
  sttCallbacks: StreamingSttCallbacks;
  vadCallbacks: VadCallbacks;
  /** Caller-owned flag — checked after every async hop so a session that
   *  was closed mid-download bails out cleanly. */
  isClosed: () => boolean;
}

export async function initializeVoiceStack(deps: ModelInitDeps): Promise<InitializedStack | null> {
  const { ctx, voiceSettings, engine, getSecret, ttsCallbacks, sttCallbacks, vadCallbacks, isClosed } = deps;
  const TIER4_MODE = engine === "tier4";

  try {
    logger.info(`[voice-session] ${ctx.sessionId}: fetching STT + TTS + VAD + Whisper models (parallel)…`);
    await Promise.all([
      ensureModelDownloaded((p) => {
        if (!isClosed()) ctx.sendEvent({ type: "stt_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
      }),
      TIER4_MODE ? Promise.resolve() : ensureTTSModelDownloaded((p) => {
        if (!isClosed()) ctx.sendEvent({ type: "tts_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
      }),
      ensureVadModelDownloaded((p) => {
        if (!isClosed()) ctx.sendEvent({ type: "vad_model_progress", overallPct: Math.round(p.overallPct) });
      }),
      ensureWhisperModelDownloaded((p) => {
        if (!isClosed()) ctx.sendEvent({ type: "whisper_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
      }, undefined, { variant: voiceSettings.whisperModel }),
    ]);
    if (isClosed()) return null;

    ctx.sendEvent({ type: "stt_model_ready" });
    ctx.sendEvent({ type: "tts_model_ready" });
    ctx.sendEvent({ type: "vad_model_ready" });
    ctx.sendEvent({ type: "whisper_model_ready" });

    // ── TTS ──
    // Dictate mode never plays audio back — server emits transcripts only.
    // Skip TTS init entirely so a tier4Provider="browser" setting doesn't
    // blow up createTier4 (its variant list is kokoro/chatterbox/edge-tts;
    // "browser" only makes sense for client-side speechSynthesis).
    let tts: StreamingTTS | null = null;
    if (ctx.mode !== "dictate") {
      if (TIER4_MODE) {
        // Provider selection. settings.voiceTier4Provider beats env
        // (LAX_VOICE_TIER4_PROVIDER), env beats the kokoro/chatterbox-clone
        // auto-pick. Set to "edge-tts" to route through the edge-tts
        // adapter (no API key, requires `npm i msedge-tts mpg123-decoder`).
        const providerOverride = voiceSettings.tier4Provider
          || process.env.LAX_VOICE_TIER4_PROVIDER?.trim();
        const variant = providerOverride && providerOverride.length > 0
          ? providerOverride
          : tier4VariantFromEnv();
        logger.info(`[voice-session] ${ctx.sessionId}: TIER4 mode → variant=${variant}`);
        // Only spread defined fields — the kokoro-engine merge below treats
        // explicit `undefined` as a real override and would clobber env vars.
        const t4 = await createTier4(
          {
            variant,
            referenceWavPath: process.env.LAX_VOICE_CLONE_REF,
            ...(voiceSettings.tier4Device ? { device: voiceSettings.tier4Device } : {}),
            ...(voiceSettings.tier4Dtype ? { dtype: voiceSettings.tier4Dtype } : {}),
            ...(voiceSettings.tier4Voice ? { voice: voiceSettings.tier4Voice } : {}),
            ...(voiceSettings.tier4Speed !== undefined ? { speed: voiceSettings.tier4Speed } : {}),
          },
          ttsCallbacks,
        );
        tts = t4 as unknown as StreamingTTS;
      } else {
        tts = createStreamingTTS(getTTSModelPaths(), ttsCallbacks);
      }
    }
    const ttsSampleRate = tts?.sampleRate ?? 0;

    // ── STT (Whisper) provider selection ──
    // settings.voiceSttProvider beats LAX_VOICE_STT_PROVIDER. Picks
    // between local-whisper (default), groq, openai, mistral, or "browser"
    // (client-side Web Speech API). Cloud providers ignore the local model
    // paths but we still resolve them so a missing key falls back
    // gracefully to local whisper. "browser" skips server-side STT
    // entirely — transcripts arrive via the WS `transcript` message and
    // feed handleFinalTranscript directly.
    const whisperPaths = getWhisperModelPaths({ variant: voiceSettings.whisperModel });
    const settingsStt = voiceSettings.sttProvider as
      | "local-whisper" | "groq" | "openai" | "mistral" | "browser" | undefined;
    const sttProviderName = settingsStt
      && (settingsStt === "local-whisper" || settingsStt === "groq" || settingsStt === "openai" || settingsStt === "mistral" || settingsStt === "browser")
      ? settingsStt
      : (resolveSttProviderName() ?? "local-whisper");

    let whisper: WhisperTranscriber | null = null;
    if (sttProviderName === "browser") {
      logger.info(`[voice-session] ${ctx.sessionId}: STT provider=browser (client-side Web Speech API; server-side Whisper/VAD skipped)`);
    } else if (sttProviderName === "local-whisper") {
      whisper = createWhisperTranscriber(whisperPaths, {
        provider: voiceSettings.whisperDevice,
      });
    } else {
      // Map provider → secret name. Encrypted secrets store is the source
      // of truth; process.env is a fallback for env-driven deployments.
      // Without this, picking "Groq" in the UI silently fell back to
      // local-whisper because the adapter throws on missing key and we
      // catch+fallback below.
      const SECRET_BY_PROVIDER: Record<string, string> = {
        groq: "GROQ_API_KEY",
        openai: "OPENAI_API_KEY",
        mistral: "MISTRAL_API_KEY",
      };
      const secretName = SECRET_BY_PROVIDER[sttProviderName];
      const apiKey = (secretName && getSecret(secretName)) || process.env[secretName ?? ""] || undefined;
      logger.info(`[voice-session] ${ctx.sessionId}: STT provider=${sttProviderName} (cloud, key ${apiKey ? "present" : "MISSING"})`);
      try {
        whisper = createSttProvider(sttProviderName, {
          local: { paths: whisperPaths, provider: voiceSettings.whisperDevice },
          cloud: apiKey ? { apiKey } : undefined,
        });
      } catch (e) {
        logger.warn(`[voice-session] ${ctx.sessionId}: cloud STT init failed (${(e as Error).message}) — falling back to local whisper`);
        whisper = createWhisperTranscriber(whisperPaths, {
          provider: voiceSettings.whisperDevice,
        });
      }
    }

    // ── Streaming-STT (Zipformer for live partials) + VAD ──
    // Only spin up when the server is doing transcription. Browser tier
    // sends finals over the WS directly, so these models are dead weight
    // there.
    let stt: StreamingSTT | null = null;
    let vad: StreamingVAD | null = null;
    if (sttProviderName !== "browser") {
      stt = createStreamingSTT(getModelPaths(), {
        onPartial: sttCallbacks.onPartial,
        // Streaming final is ignored — Whisper's output is authoritative.
        // We still call stt.flush() on speech-end to reset the Zipformer
        // decoder between utterances.
        onFinal: () => { /* suppressed */ },
        onError: sttCallbacks.onError,
      });

      vad = createStreamingVAD(getVadModelPaths(), vadCallbacks);
    }

    // tier4 surfaces the loaded voice ID so the badge can show *which*
    // Kokoro voice actually loaded; this matters if settings.voiceTier4Voice
    // was unknown and fell back to default. Speed comes from voiceSettings
    // (single source of truth — kokoro-engine doesn't re-expose it).
    const ttsRuntime = TIER4_MODE
      ? {
          ...(tts as unknown as Tier4StreamingTTS).runtime,
          voice: (tts as unknown as Tier4StreamingTTS).voice,
          ...(voiceSettings.tier4Speed !== undefined ? { speed: voiceSettings.tier4Speed } : {}),
        }
      : null;
    const sttRuntime = whisper?.runtime
      ? { ...whisper.runtime, model: whisperPaths.variant }
      : null;

    return { stt, tts, vad, whisper, ttsSampleRate, ttsRuntime, sttRuntime };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    logger.error(`[voice-session] ${ctx.sessionId}: init FAILED: ${msg}\n${(e as Error).stack || ""}`);
    if (!isClosed()) ctx.sendEvent({ type: "voice_error", message: msg });
    return null;
  }
}
