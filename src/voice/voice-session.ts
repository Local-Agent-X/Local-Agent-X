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

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { VoiceSession, VoiceSessionContext } from "./audio-ws.js";
import { createStreamingSTT, type StreamingSTT } from "./stt-stream.js";
import { ensureModelDownloaded, getModelPaths } from "./stt-model-fetch.js";
import { createStreamingTTS, type StreamingTTS } from "./tts-stream.js";
import { ensureTTSModelDownloaded, getTTSModelPaths } from "./tts-model-fetch.js";
import { createStreamingVAD, type StreamingVAD } from "./vad-stream.js";
import { ensureVadModelDownloaded, getVadModelPaths } from "./vad-model-fetch.js";
import { createWhisperTranscriber, type WhisperTranscriber } from "./whisper-stream.js";
import { ensureWhisperModelDownloaded, getWhisperModelPaths } from "./whisper-model-fetch.js";
import { createGpuSession } from "./gpu-session.js";

export interface VoiceTurnInput {
  text: string;
  history: ChatCompletionMessageParam[];
  onDelta: (text: string) => void;
  signal: AbortSignal;
  sessionId: string;
}

export interface VoiceTurnResult {
  assistantText: string;
  updatedHistory: ChatCompletionMessageParam[];
}

export type VoiceTurnRunner = (input: VoiceTurnInput) => Promise<VoiceTurnResult>;

/**
 * GPU mode dispatch. When LAX_VOICE_GPU=1 the voice pipeline runs in a
 * Python sidecar (faster-whisper + Silero VAD + Kokoro on CUDA) instead
 * of the in-process Sherpa WASM stack. The sidecar listens on
 * ws://127.0.0.1:7008/voice (overridable via LAX_VOICE_PORT).
 *
 * Setup: see python/voice/install.ps1.
 * Start:  ~/.lax/python-voice/venv/Scripts/python.exe python/voice/server.py
 */
const GPU_MODE = process.env.LAX_VOICE_GPU === "1";

const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;
// 0.25s @ 16kHz — single short words like "hey" or "yes" need to make it
// to Whisper. 0.5s was rejecting them as too short. Whisper handles brief
// audio fine; if it returns blank/bracketed annotations we filter those.
const MIN_UTTERANCE_SAMPLES = 4000;
const MAX_UTTERANCE_SAMPLES = 16000 * 22; // 22s hard cap (VAD itself cuts at 20s)

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner) {
  return (ctx: VoiceSessionContext): VoiceSession => {
    if (GPU_MODE) {
      console.log(`[voice-session] ${ctx.sessionId}: GPU mode (LAX_VOICE_GPU=1) → routing to Python sidecar`);
      return createGpuSession(ctx, runTurn);
    }

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
        console.log(`[voice-session] ${ctx.sessionId}: fetching STT + TTS + VAD + Whisper models (parallel)…`);
        await Promise.all([
          ensureModelDownloaded((p) => {
            if (!closed) ctx.sendEvent({ type: "stt_model_progress", overallPct: Math.round(p.overallPct), file: p.file });
          }),
          ensureTTSModelDownloaded((p) => {
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

        tts = createStreamingTTS(getTTSModelPaths(), {
          onAudio: (pcm) => {
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
          onError: (err) => {
            console.warn(`[voice-session] ${ctx.sessionId}: tts error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "tts_error", message: err.message });
          },
        });
        ttsSampleRate = tts.sampleRate;

        whisper = createWhisperTranscriber(getWhisperModelPaths());

        stt = createStreamingSTT(getModelPaths(), {
          onPartial: (text) => { if (!closed) ctx.sendEvent({ type: "partial", text }); },
          // Streaming final is ignored — Whisper's output is the authoritative
          // transcript. We still call stt.flush() on speech-end to reset the
          // Zipformer decoder between utterances.
          onFinal: () => { /* suppressed */ },
          onError: (err) => {
            console.warn(`[voice-session] ${ctx.sessionId}: stt runtime error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "stt_error", message: err.message });
          },
        });

        vad = createStreamingVAD(getVadModelPaths(), {
          onSpeechStart: () => handleSpeechStart(),
          onSpeechEnd: () => handleSpeechEnd(),
          onError: (err) => console.warn(`[voice-session] ${ctx.sessionId}: vad error: ${err.message}`),
        });

        stackReady = true;
        ctx.sendEvent({ type: "voice_ready", ttsSampleRate: tts.sampleRate });
        console.log(`[voice-session] ${ctx.sessionId}: ready — draining ${pendingFrames.length} pending frames`);
        while (pendingFrames.length > 0 && !closed && stt) {
          const f = pendingFrames.shift()!;
          stt.feedAudio(f);
          vad?.feedAudio(f);
        }
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.error(`[voice-session] ${ctx.sessionId}: init FAILED: ${msg}\n${(e as Error).stack || ""}`);
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
        console.log(`[voice-session] ${ctx.sessionId}: barge-in detected → interrupting agent`);
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
        console.log(`[voice-session] ${ctx.sessionId}: utterance too short (${audio.length} samples), skipping Whisper`);
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
          console.warn(`[voice-session] ${ctx.sessionId}: whisper failed: ${e.message}`);
          if (!closed) ctx.sendEvent({ type: "whisper_error", message: e.message });
        });
    }

    async function handleFinalTranscript(utterance: string): Promise<void> {
      if (closed) return;
      if (activeTurn) {
        console.log(`[voice-session] ${ctx.sessionId}: ignoring final while turn in progress: "${utterance.slice(0, 40)}"`);
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
          console.log(`[voice-session] ${ctx.sessionId}: turn aborted (barge-in)`);
          ctx.sendEvent({ type: "assistant_interrupted" });
        } else {
          console.warn(`[voice-session] ${ctx.sessionId}: turn failed: ${msg}`);
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
