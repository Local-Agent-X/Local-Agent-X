// Voice session orchestrator. Three streaming pipes + one offline post:
//   mic → VAD + streaming-STT → live partials → LLM → TTS → speaker
//   mic → utterance buffer (on VAD speech-end) → Whisper base.en → final → LLM
// Zipformer is cheap with ~10-12% WER for live partials. Whisper base.en
// (~5% WER) re-transcribes the full utterance on speech-end; that text
// (not the streaming final) is what the agent sees. Barge-in: VAD
// speech-start during an active turn aborts the LLM call, cancels TTS,
// tells the browser to drop pending audio.

import { createLogger } from "../../logger.js";
import type { VoiceSession, VoiceSessionContext } from "../audio-ws.js";
import type { StreamingSTT } from "../stt-stream.js";
import type { StreamingTTS } from "../tts-stream.js";
import type { StreamingVAD } from "../vad-stream.js";
import type { WhisperTranscriber } from "../whisper-stream.js";
import { createGpuSession } from "../gpu-session.js";
import { createRealtimeSessionFromEnv, realtimeReadiness } from "../realtime/index.js";
import type { Tier4StreamingTTS } from "../tier4/types.js";

import { resolveVoiceSettings } from "./settings.js";
import { createAudioBuffers } from "./audio-buffers.js";
import { classifyEndpointPartial, ENDPOINT_HOLD_MS } from "./endpointing.js";
import { createNearFieldGate } from "./near-field-gate.js";
import { initializeVoiceStack } from "./model-init.js";
import { createVoiceTurnMachine } from "./turn-runner.js";
import { createTier4Speaker } from "./tier4-speaker.js";
import { registerVoiceSpeaker, unregisterVoiceSpeaker } from "../proactive-registry.js";
import type { VoiceTurnRunner, SecretLookup } from "./types.js";
import { isLocalOnlyMode } from "../../local-only-policy.js";

const logger = createLogger("voice.voice-session");

export function createVoiceSessionFactory(runTurn: VoiceTurnRunner, getSecret: SecretLookup = () => "") {
  return (ctx: VoiceSessionContext): VoiceSession => {
    // Per-session settings resolution — settings.json is the source of
    // truth so a UI dropdown change picks up on the next voice session
    // without restart.
    const voiceSettings = resolveVoiceSettings();

    // OpenAI Realtime full-duplex is no longer a user-facing voice-chat tier
    // (removed from the media-page picker — it's cloud pay-per-minute and
    // bypasses LAX tools/memory/persona, so it's not the main agent). It stays
    // available as an env-gated capability for phone/meeting-bot use cases.
    // Activation is env-ONLY now: a stale settings.voiceMode="realtime" from
    // before the picker change must NOT silently route main-agent voice to the
    // cloud, so we deliberately ignore voiceSettings.mode here. Settings still
    // supply the voice/model overrides below when env opts in.
    const realtimeWanted = !isLocalOnlyMode() && process.env.LAX_VOICE_MODE === "realtime";
    if (realtimeWanted) {
      const ready = realtimeReadiness();
      if (ready.ready) {
        logger.info(`[voice-session] ${ctx.sessionId}: voiceMode=realtime → OpenAI Realtime full-duplex bridge`);
        return createRealtimeSessionFromEnv(ctx, {
          voice: voiceSettings.realtimeVoice,
          model: voiceSettings.realtimeModel,
        });
      }
      logger.warn(`[voice-session] ${ctx.sessionId}: voiceMode=realtime but ${ready.reason || "not ready"} — falling back to normal pipeline`);
    }

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
    let ttsSampleRate = 22050;
    const pendingFrames: Int16Array[] = [];

    const buffers = createAudioBuffers();

    // Smart-endpointing state: the deferred utterance commit (armed on VAD
    // speech-end, cancelled if speech resumes) and the newest streaming
    // partial, which picks the hold length. See endpointing.ts.
    let pendingCommit: ReturnType<typeof setTimeout> | null = null;
    let lastPartial = "";

    // Near-field (proximity) gate — rejects background talkers VAD can't tell
    // from the user (see near-field-gate.ts). Barge-in is DEFERRED until this
    // much near-field-loud audio accumulates, so a room-away voice never cuts
    // off a reply; commitUtterance re-checks the whole utterance so background
    // never gets transcribed either.
    const nearField = createNearFieldGate();
    const BARGE_IN_CONFIRM_MS = 150;
    let bargeInConfirmed = false;
    let nearFieldMs = 0;

    // In-process speaker (tier4-speaker.ts): streams reply text to the TTS
    // engine one punctuation-aligned chunk at a time. Getter because `tts` is
    // assigned after model init below.
    const speaker = createTier4Speaker(() => tts);

    const machine = createVoiceTurnMachine({
      ctx,
      runTurn,
      speaker,
      cancelTts: () => { try { tts?.cancel(); } catch { /* already idle */ } },
      isClosed: () => closed,
      logger,
    });

    // Make this session reachable for proactive narration (op finished /
    // worker needs input). The machine queues a proactive line behind any live
    // turn, so this is safe to call from anywhere; cleared on close below.
    registerVoiceSpeaker(ctx.sessionId, machine.speakProactive);

    // Browser tier shortcut: when the client *can* do STT itself (real
    // browser with Web Speech API), we skip the entire server stack —
    // the renderer ships transcripts via the `transcript` message and
    // uses window.speechSynthesis for TTS. Dead weight server-side.
    //
    // Two exceptions where we must NOT take this shortcut:
    //  1. mode=dictate → renderer is always streaming PCM to us (the
    //     dictate path doesn't depend on Web Speech).
    //  2. clientStt === false → Electron-Chromium can't reach Google's
    //     Speech API, so the renderer reports it can't do STT. Run
    //     server-side STT for it. TTS still goes through speechSynthesis
    //     (handled by model-init.ts skipping TTS when tier4Provider=browser).
    const isBrowserTier =
      voiceSettings.sttProvider === "browser"
      && ctx.mode !== "dictate"
      && ctx.clientStt === true;

    (async () => {
      if (isBrowserTier) {
        logger.info(`[voice-session] ${ctx.sessionId}: browser tier → skipping server-side STT/TTS/VAD/Whisper model setup`);
        stackReady = true;
        ctx.sendEvent({ type: "voice_ready", ttsSampleRate: 0, engine, tts: null, stt: { provider: "browser" } });
        return;
      }

      const result = await initializeVoiceStack({
        ctx,
        voiceSettings,
        engine,
        getSecret,
        isClosed: () => closed,
        ttsCallbacks: {
          onAudio: (pcm: Int16Array) => {
            if (closed) return;
            ctx.sendAudio(pcm);
            machine.noteAudioShipped((pcm.length / ttsSampleRate) * 1000);
          },
          onIdle: () => {
            // Worker drained its synth queue — the machine's drain signal.
            if (!closed) machine.markTtsDrained();
          },
          onError: (err: Error) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: tts error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "tts_error", message: err.message });
          },
        },
        sttCallbacks: {
          // Gate on the utterance buffer: Zipformer decodes every mic frame,
          // including TTS speaker echo and trailing audio after its decoder
          // reset, so outside a VAD-confirmed utterance its "partials" are
          // noise fragments ("SSION"). Nothing legitimate is lost — the agent
          // consumes Whisper's re-transcription of the buffered utterance,
          // never these previews.
          onPartial: (text: string) => {
            if (!closed && buffers.isBuffering) {
              lastPartial = text;
              ctx.sendEvent({ type: "partial", text });
            }
          },
          onError: (err: Error) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: stt runtime error: ${err.message}`);
            if (!closed) ctx.sendEvent({ type: "stt_error", message: err.message });
          },
        },
        vadCallbacks: {
          onSpeechStart: () => handleSpeechStart(),
          onSpeechEnd: () => handleSpeechEnd(),
          onError: (err: Error) => logger.warn(`[voice-session] ${ctx.sessionId}: vad error: ${err.message}`),
        },
      });

      if (closed || !result) return;
      ({ stt, tts, vad, whisper, ttsSampleRate } = result);

      stackReady = true;
      ctx.sendEvent({
        type: "voice_ready",
        ttsSampleRate,
        engine,
        tts: result.ttsRuntime,
        stt: result.sttRuntime,
      });
      logger.info(`[voice-session] ${ctx.sessionId}: ready — draining ${pendingFrames.length} pending frames`);
      while (pendingFrames.length > 0 && !closed && stt) {
        const f = pendingFrames.shift()!;
        stt.feedAudio(f);
        vad?.feedAudio(f);
      }
    })();

    function handleSpeechStart(): void {
      if (closed) return;
      // Same-utterance resume: VAD flagged silence but the endpoint hold
      // hadn't committed yet. Cancel the pending commit and keep buffering
      // the SAME utterance — begin() must NOT run again (it would wipe the
      // buffered audio) and the client still believes speech is live, so no
      // duplicate vad_speech_start either. No turn started (commit deferred),
      // so there is nothing to barge into.
      if (pendingCommit) {
        clearTimeout(pendingCommit);
        pendingCommit = null;
        return;
      }
      // Barge-in is DEFERRED to near-field confirmation (in onMicFrame): a
      // room-away talker fires VAD too, and interrupting the reply here would
      // let background cut it off. We still open the utterance + live-partial
      // UI now; the actual machine.interrupt() waits until enough near-field
      // audio proves it's the person at the mic. (interrupt is a no-op when
      // idle, so deferring costs nothing there.)
      ctx.sendEvent({ type: "vad_speech_start" });
      lastPartial = "";
      bargeInConfirmed = false;
      nearFieldMs = 0;
      buffers.begin();
    }

    function handleSpeechEnd(): void {
      if (closed) return;
      // Smart endpointing: VAD's ~300ms silence is right for a finished
      // sentence but chops natural mid-thought pauses into separate turns.
      // Hold the commit longer when the live partial reads unfinished;
      // resuming speech during the hold cancels it (handleSpeechStart above)
      // and the utterance continues unbroken.
      const verdict = classifyEndpointPartial(lastPartial);
      const holdMs = ENDPOINT_HOLD_MS[verdict];
      if (pendingCommit) clearTimeout(pendingCommit);
      if (holdMs <= 0) {
        commitUtterance();
        return;
      }
      logger.debug(`[voice-session] ${ctx.sessionId}: endpoint hold ${holdMs}ms (${verdict})`);
      pendingCommit = setTimeout(() => {
        pendingCommit = null;
        commitUtterance();
      }, holdMs);
    }

    function commitUtterance(): void {
      if (closed) return;
      ctx.sendEvent({ type: "vad_speech_end" });
      // Flush Zipformer so the next utterance starts with a clean decoder
      try { stt?.flush(); } catch {}

      const audio = buffers.drain();
      if (audio.length < buffers.MIN_SAMPLES) {
        logger.info(`[voice-session] ${ctx.sessionId}: utterance too short (${audio.length} samples), skipping Whisper`);
        return;
      }
      // Near-field gate: drop far-field/background utterances before Whisper so
      // a talker across the room never becomes a transcribed turn.
      const nf = nearField.accept(audio);
      if (!nf.pass) {
        logger.info(`[voice-session] ${ctx.sessionId}: dropped far-field utterance (loudness=${nf.loudness.toFixed(4)} < floor=${nf.floor.toFixed(4)})`);
        return;
      }
      if (!whisper) return;

      ctx.sendEvent({ type: "whisper_transcribing" });
      const sttStart = Date.now();
      whisper.transcribe(audio)
        .then((text) => {
          if (closed) return;
          const t = text.trim();
          if (!t) {
            ctx.sendEvent({ type: "whisper_empty" });
            return;
          }
          void machine.handleFinalTranscript(t, Date.now() - sttStart);
        })
        .catch((e: Error) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: whisper failed: ${e.message}`);
          if (!closed) ctx.sendEvent({ type: "whisper_error", message: e.message });
        });
    }

    return {
      onMicFrame(frame: Int16Array) {
        if (closed) return;
        // Browser tier: server-side STT disabled, PCM frames are noise.
        if (!stt && !vad) return;
        if (!stackReady) {
          if (pendingFrames.length < 17) pendingFrames.push(new Int16Array(frame));
          return;
        }
        stt?.feedAudio(frame);
        vad?.feedAudio(frame);
        if (buffers.isBuffering) {
          buffers.append(frame);
          // Deferred barge-in: only once enough NEAR-FIELD-loud audio has
          // accumulated do we treat this as the user cutting in and interrupt
          // the reply. A far-field talker never reaches the threshold, so the
          // reply plays on and their utterance is dropped at commit.
          if (!bargeInConfirmed) {
            if (nearField.isNearFieldFrame(frame)) nearFieldMs += (frame.length / 16);
            else nearFieldMs = Math.max(0, nearFieldMs - (frame.length / 16));
            if (nearFieldMs >= BARGE_IN_CONFIRM_MS) {
              bargeInConfirmed = true;
              machine.interrupt();
            }
          }
        } else {
          buffers.pushPreroll(frame);
        }
      },

      onEndOfSpeech() {
        if (!closed && stt) stt.flush();
      },

      onTranscript(text: string, isFinal: boolean) {
        // Browser tier: SpeechRecognition produced this. Skip VAD/Whisper;
        // interims → partial events, finals enter the same path as Whisper.
        if (closed) return;
        const t = text.trim();
        if (!t) return;
        if (!isFinal) {
          ctx.sendEvent({ type: "partial", text: t });
          return;
        }
        machine.handleFinalTranscript(t).catch((e) => {
          logger.warn(`[voice-session] ${ctx.sessionId}: handleFinalTranscript failed: ${(e as Error).message}`);
        });
      },

      onVoiceSettings(settings: { voice?: string; speed?: number }) {
        // Live voice swap from the chat-bar picker. Adapters that pick
        // voice per-utterance (kokoro) handle this via speak() and no-op
        // here; edge-tts and clone-style adapters expose setVoice.
        if (closed) return;
        const v = settings.voice;
        if (!v) return;
        const t4 = tts as unknown as Tier4StreamingTTS;
        if (typeof t4?.setVoice === "function") {
          void t4.setVoice(v).catch((e) => {
            logger.warn(`[voice-session] ${ctx.sessionId}: setVoice failed: ${(e as Error).message}`);
          });
        }
      },

      close() {
        if (closed) return;
        closed = true;
        if (pendingCommit) { clearTimeout(pendingCommit); pendingCommit = null; }
        unregisterVoiceSpeaker(ctx.sessionId);
        machine.close();
        try { stt?.close(); } catch {}
        try { tts?.close(); } catch {}
        try { vad?.close(); } catch {}
        try { whisper?.close(); } catch {}
        pendingFrames.length = 0;
        buffers.clear();
      },
    };
  };
}

export type { VoiceTurnInput, VoiceTurnResult, VoiceTurnRunner, SecretLookup } from "./types.js";
export type { VoiceEngineId } from "./settings.js";
