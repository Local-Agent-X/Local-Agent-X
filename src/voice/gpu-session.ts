// GPU-mode voice session.
//
// All speech work (VAD + STT + TTS) happens in the Python sidecar; this
// module is a thin orchestrator that wires the bridge's events to the
// browser-facing WS events and runs the LLM turn between final transcript
// and first TTS sentence.
//
// The CPU-mode createVoiceSessionFactory in voice-session.ts dispatches
// here when LAX_VOICE_GPU=1. Both modes implement the same VoiceSession
// shape, so audio-ws.ts doesn't need to know which path is active.

import type { VoiceSession, VoiceSessionContext } from "./audio-ws.js";
import { createGPUBridge, type GPUBridge } from "./gpu-bridge.js";
import { createVoiceTurnMachine, SENTENCE_TERMINATOR, type TurnSpeaker } from "./voice-session/turn-runner.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.gpu-session");
// Long-clause early-flush: if the LLM is grinding out a long comma-heavy
// sentence, fire the first clause to TTS as soon as it's >= ~60 chars and
// has a comma. Cuts time-to-first-audio by 200-500ms on those sentences
// without changing what the listener actually hears (TTS just sees one
// sentence as two clauses).
const CLAUSE_BREAK = /[,;:]\s+/;  // also split on semicolons/colons, not just commas
const CLAUSE_MIN_CHARS = 30;       // was 60; smaller chunks reduce per-sentence synth time so RTF~1 hardware leaves shorter audible gaps

export function createGpuSession(ctx: VoiceSessionContext, runTurn: VoiceTurnRunner): VoiceSession {
  let bridge: GPUBridge | null = null;
  let bridgeReady = false;
  let closed = false;
  let pendingTtsCount = 0;
  let nextSentenceId = 1;
  const pendingFrames: Int16Array[] = [];

  // Per-session voice settings, controlled live by the browser via the
  // voice_settings WS message. Undefined = use sidecar's env defaults.
  let voiceOverride: string | undefined;
  let speedOverride: number | undefined;

  // GPU speaker: clause-split long sentences + early-flush the first clause so
  // time-to-first-audio stays low on the sidecar's RTF~1 hardware. Each chunk
  // bumps pendingTtsCount; onAudioDone counts it back down and signals the
  // machine when the queue empties.
  const LONG_SENTENCE_CHARS = 50;
  let sentenceBuf = "";
  let firstClauseFlushed = false;
  let queuedThisTurn = false;
  const speakChunk = (text: string): void => {
    if (!text || !bridge) return;
    pendingTtsCount++;
    bridge.speak(text, nextSentenceId++, { voice: voiceOverride, speed: speedOverride });
    firstClauseFlushed = true;
    queuedThisTurn = true;
  };
  const speakSentence = (raw: string): void => {
    const sentence = raw.trim();
    if (!sentence) return;
    if (sentence.length < LONG_SENTENCE_CHARS) { speakChunk(sentence); return; }
    // Split a long sentence on commas/semicolons so each chunk's synth time
    // stays under the previous chunk's playback time (no audible gap).
    const parts: string[] = [];
    let remaining = sentence;
    while (remaining.length > 0) {
      const m = CLAUSE_BREAK.exec(remaining);
      if (!m || m.index < CLAUSE_MIN_CHARS - 10) break;
      const cut = m.index + m[0].length;
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut);
    }
    if (remaining.trim()) parts.push(remaining.trim());
    for (const p of parts) speakChunk(p);
  };
  const speaker: TurnSpeaker = {
    reset() { sentenceBuf = ""; firstClauseFlushed = false; queuedThisTurn = false; },
    feed(delta) {
      sentenceBuf += delta;
      // Sentence terminators (.!?) — preferred boundary.
      while (true) {
        const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
        if (!m) break;
        const cutEnd = m.index + m[0].length;
        speakSentence(sentenceBuf.slice(0, cutEnd));
        sentenceBuf = sentenceBuf.slice(cutEnd);
      }
      // Early-clause flush: no period yet but the buffer is long and has a
      // clause break — emit the FIRST clause so TTS starts sooner. Once per
      // turn; after that speakSentence's splitter handles long sentences.
      if (!firstClauseFlushed && sentenceBuf.length >= CLAUSE_MIN_CHARS) {
        const m = CLAUSE_BREAK.exec(sentenceBuf);
        if (m && m.index >= CLAUSE_MIN_CHARS - 10) {
          const cutEnd = m.index + m[0].length;
          speakChunk(sentenceBuf.slice(0, cutEnd).trim());
          sentenceBuf = sentenceBuf.slice(cutEnd);
        }
      }
    },
    flushTail() {
      const tail = sentenceBuf.trim();
      if (tail) speakSentence(tail);
      sentenceBuf = "";
    },
    hasQueued() { return queuedThisTurn; },
    pendingCount() { return pendingTtsCount; },
  };

  const machine = createVoiceTurnMachine({
    ctx,
    runTurn,
    speaker,
    cancelTts: () => { try { bridge?.cancelTTS(); } catch { /* already idle */ } },
    isClosed: () => closed,
    logger,
  });

  bridge = createGPUBridge({
    onReady: (gpu) => {
      bridgeReady = true;
      ctx.sendEvent({ type: "voice_ready", ttsSampleRate: bridge!.ttsSampleRate, gpu });
      ctx.sendEvent({ type: "stt_model_ready" });
      ctx.sendEvent({ type: "tts_model_ready" });
      ctx.sendEvent({ type: "vad_model_ready" });
      logger.info(`[gpu-session] ${ctx.sessionId}: bridge ready (gpu=${gpu}). draining ${pendingFrames.length} pending frames`);
      while (pendingFrames.length > 0 && !closed && bridge) {
        bridge.feedAudio(pendingFrames.shift()!);
      }
    },
    onSpeechStart: () => {
      ctx.sendEvent({ type: "vad_speech_start" });
      // Barge-in (no-op when idle): machine aborts the turn, cancels TTS, tells
      // the browser to drop pending audio. Reset our chunk counter so late
      // audio_done callbacks from the killed turn don't bleed into the next.
      machine.interrupt();
      pendingTtsCount = 0;
    },
    onSpeechEnd: () => { ctx.sendEvent({ type: "vad_speech_end" }); },
    onPartial: (text) => { ctx.sendEvent({ type: "partial", text }); },
    onFinal: (text, ms) => {
      // The machine emits the `final` event (with sttMs) after its guards.
      void machine.handleFinalTranscript(text, ms);
    },
    onAudioChunk: (pcm, sr /*, id, isFinal */) => {
      ctx.sendAudio(pcm);
      machine.noteAudioShipped((pcm.length / (sr || 24000)) * 1000);
    },
    onAudioDone: (_sentenceId, _ms, _cancelled) => {
      pendingTtsCount = Math.max(0, pendingTtsCount - 1);
      // Last chunk drained — the machine's drain signal (it gates on llmDone +
      // an active turn internally and schedules the real end-of-playback).
      if (pendingTtsCount === 0) machine.markTtsDrained();
    },
    onError: (message) => {
      ctx.sendEvent({ type: "voice_error", message });
    },
    onDisconnect: () => {
      if (!closed) ctx.sendEvent({ type: "voice_error", message: "GPU sidecar disconnected" });
    },
  });

  bridge.ready().catch((e: Error & { code?: string }) => {
    // ECONNREFUSED here means the user opted into GPU voice but hasn't
    // started the Python sidecar — log at info, not error, so it doesn't
    // look like a runtime fault. The UI still gets a clear voice_error
    // event so the user sees what's wrong without digging in server logs.
    if (e.code === "ECONNREFUSED") {
      logger.info(`[gpu-session] ${ctx.sessionId}: GPU sidecar not running on :${process.env.LAX_VOICE_PORT || 7008}`);
    } else {
      logger.error(`[gpu-session] ${ctx.sessionId}: bridge init failed: ${e.message}`);
    }
    if (!closed) ctx.sendEvent({ type: "voice_error", message: `GPU sidecar unavailable: ${e.message}. Make sure the Python sidecar is running on ${process.env.LAX_VOICE_PORT || 7008}.` });
  });

  return {
    onMicFrame(frame: Int16Array) {
      if (closed) return;
      if (!bridgeReady) {
        if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
        return;
      }
      bridge?.feedAudio(frame);
    },

    onEndOfSpeech() {
      if (!closed) bridge?.flush();
    },

    onVoiceSettings(settings) {
      if (settings.voice) voiceOverride = settings.voice;
      if (typeof settings.speed === "number" && settings.speed > 0.5 && settings.speed < 2.0) {
        speedOverride = settings.speed;
      }
      logger.info(`[gpu-session] ${ctx.sessionId}: voice settings → voice=${voiceOverride || "(default)"} speed=${speedOverride ?? "(default)"}`);
    },

    close() {
      if (closed) return;
      closed = true;
      machine.close();
      try { bridge?.close(); } catch {}
      pendingFrames.length = 0;
    },
  };
}
