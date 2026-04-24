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

const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;
const MIN_UTTERANCE_SAMPLES = 8000; // 0.5s @ 16kHz — skip Whisper on sub-500ms blips
const MAX_UTTERANCE_SAMPLES = 16000 * 22; // 22s hard cap (VAD itself cuts at 20s)

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner) {
  return (ctx: VoiceSessionContext): VoiceSession => {
    let stt: StreamingSTT | null = null;
    let tts: StreamingTTS | null = null;
    let vad: StreamingVAD | null = null;
    let whisper: WhisperTranscriber | null = null;
    let stackReady = false;
    let closed = false;
    let activeTurn: AbortController | null = null;
    let history: ChatCompletionMessageParam[] = [];
    const pendingFrames: Int16Array[] = [];

    // Utterance buffer — filled between VAD speech-start and speech-end
    const utteranceFrames: Int16Array[] = [];
    let utteranceSamples = 0;
    let bufferingUtterance = false;

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
          onAudio: (pcm) => { if (!closed) ctx.sendAudio(pcm); },
          onIdle: () => { if (!closed) ctx.sendEvent({ type: "tts_idle" }); },
          onError: (err) => {
            console.warn(`[voice-session] ${ctx.sessionId}: tts error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "tts_error", message: err.message });
          },
        });

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
      bufferingUtterance = true;
    }

    function appendToUtterance(frame: Int16Array): void {
      if (!bufferingUtterance) return;
      if (utteranceSamples >= MAX_UTTERANCE_SAMPLES) return; // VAD will cut soon
      utteranceFrames.push(new Int16Array(frame));
      utteranceSamples += frame.length;
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
        try { activeTurn.abort(); } catch {}
        try { tts?.cancel(); } catch {}
        ctx.sendEvent({ type: "tts_interrupt" });
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

      let sentenceBuf = "";
      const flushCompletedSentences = (): void => {
        if (!tts) return;
        while (true) {
          const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
          if (!m) break;
          const cutEnd = m.index + m[0].length;
          const sentence = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (sentence) tts.speak(sentence);
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
        } else {
          const tail = sentenceBuf.trim();
          if (tail && tts) tts.speak(tail);
          history = result.updatedHistory;
          ctx.sendEvent({ type: "assistant_done", text: result.assistantText });
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
      } finally {
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
        appendToUtterance(frame);
      },

      onEndOfSpeech() {
        if (!closed && stt) stt.flush();
      },

      close() {
        if (closed) return;
        closed = true;
        try { activeTurn?.abort(); } catch {}
        try { stt?.close(); } catch {}
        try { tts?.close(); } catch {}
        try { vad?.close(); } catch {}
        try { whisper?.close(); } catch {}
        pendingFrames.length = 0;
        utteranceFrames.length = 0;
      },
    };
  };
}
