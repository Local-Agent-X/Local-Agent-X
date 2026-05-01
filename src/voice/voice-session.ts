// Voice session orchestrator.
//
// Three streaming pipes + one offline post-pass:
//   mic → VAD + streaming-STT → live partials (yellow UI)
//                             → LLM → TTS → speaker
//   mic → utterance buffer
//     (on VAD speech-end) → Whisper base.en → authoritative final → LLM
//
// Design: Zipformer streaming is cheap and gives live partials for snappy
// UX, but has ~10-12% WER. We use Whisper base.en (~5% WER) to re-transcribe
// the complete utterance the moment VAD sees speech-end. That Whisper text
// — not the streaming final — is what the agent sees. Streaming STT's own
// onFinal is dropped.
//
// Barge-in: VAD speech-start during an active agent turn kills the LLM
// call, flushes the TTS queue, and tells the browser to drop pending audio.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { VoiceSession, VoiceSessionContext } from "./audio-ws.js";
import { createStreamingSTT, type StreamingSTT } from "./stt-stream.js";
import { ensureModelDownloaded, getModelPaths } from "./stt-model-fetch.js";
import { createStreamingTTS, type StreamingTTS } from "./tts-stream.js";
import { ensureTTSModelDownloaded, getTTSModelPaths } from "./tts-model-fetch.js";
import { createStreamingVAD, type StreamingVAD } from "./vad-stream.js";
import { ensureVadModelDownloaded, getVadModelPaths } from "./vad-model-fetch.js";
import {
  createWhisperTranscriber,
  VALID_WHISPER_PROVIDERS,
  type WhisperProvider,
  type WhisperTranscriber,
} from "./whisper-stream.js";
import { ensureWhisperModelDownloaded, getWhisperModelPaths } from "./whisper-model-fetch.js";
import { createGpuSession } from "./gpu-session.js";
import { createTier4, tier4VariantFromEnv } from "./tier4/index.js";
import { VALID_DEVICES as VALID_TIER4_DEVICES, VALID_DTYPES as VALID_TIER4_DTYPES } from "./tier4/env.js";
import type { Tier4Device, Tier4Dtype, Tier4StreamingTTS } from "./tier4/types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.voice-session");

export interface VoiceTurnInput {
  text: string;
  history: ChatCompletionMessageParam[];
  onDelta: (text: string) => void;
  /** Forwarded by the agent when it calls voice_visual — bridges the
   *  tool's side-effect event back to the WebSocket so the browser can
   *  morph particles. Optional; if omitted the visualizer is silent. */
  onVisual?: (kind: "emoji" | "text" | "shape" | "mood", value: string, durationMs: number) => void;
  signal: AbortSignal;
  sessionId: string;
}

export interface VoiceTurnResult {
  assistantText: string;
  updatedHistory: ChatCompletionMessageParam[];
}

export type VoiceTurnRunner = (input: VoiceTurnInput) => Promise<VoiceTurnResult>;

/**
 * GPU mode dispatch. The voice pipeline runs in a Python sidecar
 * (faster-whisper + Silero VAD + Kokoro on CUDA) by default. The
 * sidecar listens on ws://127.0.0.1:7008/voice (overridable via
 * LAX_VOICE_PORT). Set LAX_VOICE_GPU=0 to force the legacy in-process
 * Sherpa WASM + Matcha CPU path (only useful for machines without a
 * working sidecar — quality is markedly worse and voice picker is a no-op).
 * Custom voice cloning lives in the optional Pro tier (RVC sidecar at
 * :7009, separate venv); not handled by this dispatcher.
 *
 * Setup: see python/voice/install.ps1.
 * Start:  ~/.lax/python-voice/venv/Scripts/python.exe python/voice/server.py
 */
// ── Engine selection ─────────────────────────────────────────────────────
// The user picks which voice engine to use from Settings → Voice. The choice
// lives in `~/.lax/settings.json` as `voiceEngine` and is the single source
// of truth. Env vars (LAX_VOICE_GPU, LAX_VOICE_TIER) are dev escape-hatches
// only — used for headless/CI runs and to override settings during
// debugging. Order of precedence:
//   1. settings.voiceEngine (user choice, primary)
//   2. LAX_VOICE_TIER=4 → tier4
//   3. LAX_VOICE_GPU=0   → cpu_fallback (legacy Matcha)
//   4. default            → python (GPU sidecar, lite tier)
//
// Engine values (stable IDs — UI uses these as the dropdown values):
//   "tier4"        — native ONNX Kokoro, no Python, ~1.2s first-audio
//   "python"       — Python sidecar (GPU). Sub-tier picked by python sidecar
//                    via its own LAX_VOICE_PORT (Lite 7008 / Pro 7009 / Studio 7010)
//   "cpu_fallback" — in-process Sherpa WASM + Matcha (slow, low quality, no
//                    Python or GPU needed — emergency fallback only)
export type VoiceEngineId = "tier4" | "python" | "cpu_fallback";

interface ResolvedVoiceSettings {
  engine: VoiceEngineId;
  tier4Device?: Tier4Device;
  tier4Dtype?: Tier4Dtype;
  whisperDevice?: WhisperProvider;
}

function resolveVoiceSettings(): ResolvedVoiceSettings {
  // 1. Settings file wins. Lives at $LAX_DATA_DIR/settings.json (typically
  //    ~/.lax/settings.json). Read on each session creation so users can
  //    flip engines / devices from the UI without restarting the server.
  const out: ResolvedVoiceSettings = { engine: "python" };
  let savedEngine: VoiceEngineId | undefined;
  try {
    const dataDir = process.env.LAX_DATA_DIR || join(homedir(), ".lax");
    const sp = join(dataDir, "settings.json");
    if (existsSync(sp)) {
      const saved = JSON.parse(readFileSync(sp, "utf-8")) as {
        voiceEngine?: string;
        voiceTier4Device?: string;
        voiceTier4Dtype?: string;
        voiceWhisperDevice?: string;
      };
      if (saved.voiceEngine === "tier4" || saved.voiceEngine === "python" || saved.voiceEngine === "cpu_fallback") {
        savedEngine = saved.voiceEngine;
      }
      const td = saved.voiceTier4Device?.toLowerCase() as Tier4Device | undefined;
      if (td && VALID_TIER4_DEVICES.has(td)) out.tier4Device = td;
      const tdt = saved.voiceTier4Dtype?.toLowerCase() as Tier4Dtype | undefined;
      if (tdt && VALID_TIER4_DTYPES.has(tdt)) out.tier4Dtype = tdt;
      const wd = saved.voiceWhisperDevice?.toLowerCase() as WhisperProvider | undefined;
      if (wd && VALID_WHISPER_PROVIDERS.has(wd)) out.whisperDevice = wd;
    }
  } catch { /* settings file unreadable — fall through to env */ }
  if (savedEngine) {
    out.engine = savedEngine;
  } else if (process.env.LAX_VOICE_TIER === "4") {
    out.engine = "tier4";
  } else if (process.env.LAX_VOICE_GPU === "0") {
    out.engine = "cpu_fallback";
  }
  return out;
}

const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;
// 0.25s @ 16kHz — single short words like "hey" or "yes" need to make it
// to Whisper. 0.5s was rejecting them as too short. Whisper handles brief
// audio fine; if it returns blank/bracketed annotations we filter those.
const MIN_UTTERANCE_SAMPLES = 4000;
const MAX_UTTERANCE_SAMPLES = 16000 * 22; // 22s hard cap (VAD itself cuts at 20s)

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner) {
  return (ctx: VoiceSessionContext): VoiceSession => {
    // Per-session settings resolution — settings.json is the source of truth
    // so a UI dropdown change picks up on the next voice session without restart.
    const voiceSettings = resolveVoiceSettings();
    const engine = voiceSettings.engine;
    const TIER4_MODE = engine === "tier4";
    if (engine === "python") {
      logger.info(`[voice-session] ${ctx.sessionId}: engine=python → routing to Python sidecar`);
      return createGpuSession(ctx, runTurn);
    }
    logger.info(`[voice-session] ${ctx.sessionId}: engine=${engine} → in-process${TIER4_MODE ? " (Tier 4 native ONNX Kokoro)" : " (CPU fallback Sherpa+Matcha)"}`);

    let stt: StreamingSTT | null = null;
    let tts: StreamingTTS | null = null;
    let vad: StreamingVAD | null = null;
    let whisper: WhisperTranscriber | null = null;
    let stackReady = false;
    let closed = false;
    let activeTurn: AbortController | null = null;
    let llmDone = false; // LLM finished; waiting on TTS queue to drain
    let ttsQueuedThisTurn = false; // track if any sentence was queued
    // Playback-completion estimator. The browser's playback ring buffer
    // holds 1-3 seconds beyond what the worker has emitted, so onIdle from
    // the worker is too early to clear activeTurn — barge-in stops working
    // as soon as the WASM queue drains, even though the user is still
    // hearing audio. Tracking samples-shipped + a constant playback rate
    // lets us schedule the real end-of-playback.
    let expectedPlaybackEndMs = 0;
    let pendingClearTimer: NodeJS.Timeout | null = null;
    let ttsSampleRate = 22050;
    const PLAYBACK_TAIL_MS = 250; // grace for browser scheduler / network jitter
    let history: ChatCompletionMessageParam[] = [];
    const pendingFrames: Int16Array[] = [];

    // Utterance buffer — filled between VAD speech-start and speech-end.
    const utteranceFrames: Int16Array[] = [];
    let utteranceSamples = 0;
    let bufferingUtterance = false;

    // Rolling pre-roll buffer (last ~250ms of mic audio). When VAD fires
    // speech-start, we prepend this so the actual onset of the word makes
    // it to Whisper. Without it, short words like "hey" get chopped off
    // because Silero needs 200ms of speech to confirm onset.
    const PREROLL_SAMPLES = 4000; // 250ms @ 16kHz
    const prerollFrames: Int16Array[] = [];
    let prerollSampleCount = 0;

    (async () => {
      try {
        logger.info(`[voice-session] ${ctx.sessionId}: fetching STT + TTS + VAD + Whisper models (parallel)…`);
        await Promise.all([
          ensureModelDownloaded((p) => {
            if (!closed) ctx.sendEvent({ type: "stt_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
          }),
          TIER4_MODE ? Promise.resolve() : ensureTTSModelDownloaded((p) => {
            if (!closed) ctx.sendEvent({ type: "tts_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
          }),
          ensureVadModelDownloaded((p) => {
            if (!closed) ctx.sendEvent({ type: "vad_model_progress", overallPct: Math.round(p.overallPct) });
          }),
          ensureWhisperModelDownloaded((p) => {
            if (!closed) ctx.sendEvent({ type: "whisper_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
          }),
        ]);
        if (closed) return;

        ctx.sendEvent({ type: "stt_model_ready" });
        ctx.sendEvent({ type: "tts_model_ready" });
        ctx.sendEvent({ type: "vad_model_ready" });
        ctx.sendEvent({ type: "whisper_model_ready" });

        const ttsCallbacks = {
          onAudio: (pcm: Int16Array) => {
            if (closed) return;
            ctx.sendAudio(pcm);
            // Push expected end-of-playback forward by this chunk's duration
            const now = Date.now();
            const chunkMs = (pcm.length / ttsSampleRate) * 1000;
            expectedPlaybackEndMs = Math.max(now, expectedPlaybackEndMs) + chunkMs;
          },
          onIdle: () => {
            if (closed) return;
            ctx.sendEvent({ type: "tts_idle" });
            // Worker is done synthesizing, but the browser's playback ring
            // still has buffered audio. Schedule activeTurn release at the
            // estimated true end-of-playback rather than now.
            if (llmDone && activeTurn) {
              if (pendingClearTimer) clearTimeout(pendingClearTimer);
              const delay = Math.max(0, expectedPlaybackEndMs - Date.now() + PLAYBACK_TAIL_MS);
              pendingClearTimer = setTimeout(() => {
                pendingClearTimer = null;
                if (activeTurn && !closed) {
                  activeTurn = null;
                  llmDone = false;
                  ctx.sendEvent({ type: "playback_complete" });
                }
              }, delay);
            }
          },
          onError: (err: Error) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: tts error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "tts_error", message: err.message });
          },
        };

        if (TIER4_MODE) {
          logger.info(`[voice-session] ${ctx.sessionId}: TIER4 mode (LAX_VOICE_TIER=4) → native Kokoro ONNX`);
          // Only spread defined fields — the kokoro-engine merge below treats
          // explicit `undefined` as a real override and would clobber env vars.
          const t4 = await createTier4(
            {
              variant: tier4VariantFromEnv(),
              referenceWavPath: process.env.LAX_VOICE_CLONE_REF,
              ...(voiceSettings.tier4Device ? { device: voiceSettings.tier4Device } : {}),
              ...(voiceSettings.tier4Dtype ? { dtype: voiceSettings.tier4Dtype } : {}),
            },
            ttsCallbacks,
          );
          tts = t4 as unknown as StreamingTTS;
        } else {
          tts = createStreamingTTS(getTTSModelPaths(), ttsCallbacks);
        }
        ttsSampleRate = tts.sampleRate;

        whisper = createWhisperTranscriber(getWhisperModelPaths(), {
          provider: voiceSettings.whisperDevice,
        });

        stt = createStreamingSTT(getModelPaths(), {
          onPartial: (text) => { if (!closed) ctx.sendEvent({ type: "partial", text }); },
          // Streaming final is ignored — Whisper's output is the authoritative
          // transcript. We still call stt.flush() on speech-end to reset the
          // Zipformer decoder between utterances.
          onFinal: () => { /* suppressed */ },
          onError: (err) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: stt runtime error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "stt_error", message: err.message });
          },
        });

        vad = createStreamingVAD(getVadModelPaths(), {
          onSpeechStart: () => handleSpeechStart(),
          onSpeechEnd: () => handleSpeechEnd(),
          onError: (err) => logger.warn(`[voice-session] ${ctx.sessionId}: vad error: ${err.message}`),
        });

        stackReady = true;
        const ttsRuntime = TIER4_MODE
          ? (tts as unknown as Tier4StreamingTTS).runtime
          : null;
        const sttRuntime = whisper?.runtime ?? null;
        ctx.sendEvent({
          type: "voice_ready",
          ttsSampleRate: tts.sampleRate,
          engine,
          tts: ttsRuntime,
          stt: sttRuntime,
        });
        logger.info(`[voice-session] ${ctx.sessionId}: ready — draining ${pendingFrames.length} pending frames`);
        while (pendingFrames.length > 0 && !closed && stt) {
          const f = pendingFrames.shift()!;
          stt.feedAudio(f);
          vad?.feedAudio(f);
        }
      } catch (e) {
        const msg = (e as Error).message || String(e);
        logger.error(`[voice-session] ${ctx.sessionId}: init FAILED: ${msg}\n${(e as Error).stack || ""}`);
        if (!closed) ctx.sendEvent({ type: "voice_error", message: msg });
      }
    })();

    function beginUtteranceBuffer(): void {
      utteranceFrames.length = 0;
      utteranceSamples = 0;
      // Seed with whatever pre-roll we have — recovers the missing 200ms
      // onset that VAD silero needed before declaring speech.
      for (const f of prerollFrames) {
        utteranceFrames.push(f);
        utteranceSamples += f.length;
      }
      bufferingUtterance = true;
    }

    function appendToUtterance(frame: Int16Array): void {
      if (!bufferingUtterance) return;
      if (utteranceSamples >= MAX_UTTERANCE_SAMPLES) return; // VAD will cut soon
      utteranceFrames.push(new Int16Array(frame));
      utteranceSamples += frame.length;
    }

    function pushPreroll(frame: Int16Array): void {
      // Keep the last ~250ms of mic audio in a sliding window. We only need
      // to copy when buffering is OFF (during speech, frames go straight
      // into utteranceFrames). Sharing the same Int16Array across both
      // buffers is safe because we never mutate them after capture.
      prerollFrames.push(new Int16Array(frame));
      prerollSampleCount += frame.length;
      while (prerollSampleCount > PREROLL_SAMPLES && prerollFrames.length > 0) {
        prerollSampleCount -= prerollFrames[0].length;
        prerollFrames.shift();
      }
    }

    function drainUtteranceBuffer(): Int16Array {
      const merged = new Int16Array(utteranceSamples);
      let off = 0;
      for (const f of utteranceFrames) {
        merged.set(f, off);
        off += f.length;
      }
      utteranceFrames.length = 0;
      utteranceSamples = 0;
      bufferingUtterance = false;
      return merged;
    }

    function handleSpeechStart(): void {
      if (closed) return;
      // Barge-in: user started talking while the agent was mid-reply.
      if (activeTurn) {
        logger.info(`[voice-session] ${ctx.sessionId}: barge-in detected → interrupting agent`);
        if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
        try { activeTurn.abort(); } catch {}
        try { tts?.cancel(); } catch {}
        ctx.sendEvent({ type: "tts_interrupt" });
        activeTurn = null;
        llmDone = false;
        expectedPlaybackEndMs = 0;
      }
      ctx.sendEvent({ type: "vad_speech_start" });
      beginUtteranceBuffer();
    }

    function handleSpeechEnd(): void {
      if (closed) return;
      ctx.sendEvent({ type: "vad_speech_end" });
      // Flush Zipformer so the next utterance starts with a clean decoder
      try { stt?.flush(); } catch {}

      const audio = drainUtteranceBuffer();
      if (audio.length < MIN_UTTERANCE_SAMPLES) {
        logger.info(`[voice-session] ${ctx.sessionId}: utterance too short (${audio.length} samples), skipping Whisper`);
        return;
      }
      if (!whisper) return;

      ctx.sendEvent({ type: "whisper_transcribing" });
      whisper.transcribe(audio)
        .then((text) => {
          if (closed) return;
          const t = text.trim();
          if (!t) {
            ctx.sendEvent({ type: "whisper_empty" });
            return;
          }
          handleFinalTranscript(t);
        })
        .catch((e: Error) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: whisper failed: ${e.message}`);
          if (!closed) ctx.sendEvent({ type: "whisper_error", message: e.message });
        });
    }

    async function handleFinalTranscript(utterance: string): Promise<void> {
      if (closed) return;
      if (activeTurn) {
        logger.info(`[voice-session] ${ctx.sessionId}: ignoring final while turn in progress: "${utterance.slice(0, 40)}"`);
        return;
      }

      ctx.sendEvent({ type: "final", text: utterance });
      ctx.sendEvent({ type: "agent_start" });
      activeTurn = new AbortController();
      llmDone = false;
      ttsQueuedThisTurn = false;

      let sentenceBuf = "";
      const flushCompletedSentences = (): void => {
        if (!tts) return;
        while (true) {
          const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
          if (!m) break;
          const cutEnd = m.index + m[0].length;
          const sentence = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (sentence) {
            tts.speak(sentence);
            ttsQueuedThisTurn = true;
          }
        }
      };

      try {
        const result = await runTurn({
          text: utterance,
          history,
          sessionId: ctx.sessionId,
          signal: activeTurn.signal,
          onDelta: (delta) => {
            if (closed || activeTurn?.signal.aborted) return;
            if (!delta) return;
            ctx.sendEvent({ type: "assistant_delta", text: delta });
            sentenceBuf += delta;
            flushCompletedSentences();
          },
          onVisual: (kind, value, durationMs) => {
            if (closed) return;
            ctx.sendEvent({ type: "visual", kind, value, durationMs });
          },
        });

        if (activeTurn?.signal.aborted) {
          ctx.sendEvent({ type: "assistant_interrupted" });
          activeTurn = null; // free immediately on abort
        } else {
          const tail = sentenceBuf.trim();
          if (tail && tts) {
            tts.speak(tail);
            ttsQueuedThisTurn = true;
          }
          history = result.updatedHistory;
          ctx.sendEvent({ type: "assistant_done", text: result.assistantText });
          // Don't clear activeTurn here. The TTS queue may still be draining
          // (Anthropic often bursts the full reply faster than synthesis can
          // keep up). Hold the turn open until onIdle fires so barge-in keeps
          // working through TTS playback. Edge case: if nothing was queued
          // (empty/short reply), onIdle won't fire — clear immediately.
          if (!ttsQueuedThisTurn) {
            activeTurn = null;
          } else {
            llmDone = true;
          }
        }
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (activeTurn?.signal.aborted) {
          logger.info(`[voice-session] ${ctx.sessionId}: turn aborted (barge-in)`);
          ctx.sendEvent({ type: "assistant_interrupted" });
        } else {
          logger.warn(`[voice-session] ${ctx.sessionId}: turn failed: ${msg}`);
          ctx.sendEvent({ type: "agent_error", message: msg });
        }
        activeTurn = null;
      }
    }

    return {
      onMicFrame(frame: Int16Array) {
        if (closed) return;
        if (!stackReady) {
          if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
          return;
        }
        stt?.feedAudio(frame);
        vad?.feedAudio(frame);
        if (bufferingUtterance) {
          appendToUtterance(frame);
        } else {
          pushPreroll(frame);
        }
      },

      onEndOfSpeech() {
        if (!closed && stt) stt.flush();
      },

      close() {
        if (closed) return;
        closed = true;
        if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
        try { activeTurn?.abort(); } catch {}
        try { stt?.close(); } catch {}
        try { tts?.close(); } catch {}
        try { vad?.close(); } catch {}
        try { whisper?.close(); } catch {}
        pendingFrames.length = 0;
        utteranceFrames.length = 0;
        prerollFrames.length = 0;
      },
    };
  };
}
