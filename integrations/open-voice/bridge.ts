// Bridge from existing in-tree SAX adapters to the open-voice orchestrator.
//
// Why a bridge? open-voice ships factory contracts that expect callbacks at
// adapter-build time (`(cb) => Adapter`). The current SAX adapters use a
// slightly different shape — they take a model-paths object plus an options
// bag with the same callbacks merged in. This file does the trivial
// reshaping so we can hand the whole thing to `createVoiceSession` from
// open-voice and keep using SAX's existing model fetchers, GPU paths, and
// LLM glue without porting any of that into the library.
//
// Behind a feature flag (LAX_VOICE_OPEN=1) — the legacy in-tree orchestrator
// in src/voice/voice-session.ts stays the default for one release while we
// A/B the p50/p95 latency on real input.
//
// Once the bridge is the default, src/voice/voice-session.ts drops ~250 LOC
// of orchestration and we delete the duplicate clause-chunker/preroll/playback
// logic — open-voice owns it.

import type {
  OfflineTranscriber,
  Pcm16,
  SttAdapter,
  TtsAdapter,
  VadAdapter,
  VoiceEvent,
  VoiceSession,
  VoiceSessionConfig,
  ChatMessage,
} from "open-voice";
import { createVoiceSession } from "open-voice";

export interface SaxVadModule {
  createStreamingVAD(paths: unknown, opts: {
    onSpeechStart(): void;
    onSpeechEnd(): void;
    onError?(e: Error): void;
  }): VadAdapter;
  getVadModelPaths(): unknown;
}

export interface SaxSttModule {
  createStreamingSTT(paths: unknown, opts: {
    onPartial(t: string): void;
    onFinal?(t: string): void;
    onError?(e: Error): void;
  }): SttAdapter;
  getSttModelPaths(): unknown;
}

export interface SaxTtsModule {
  createStreamingTTS(paths: unknown, opts: {
    onAudio(pcm: Pcm16, sr: number): void;
    onIdle(): void;
    onError?(e: Error): void;
  }): TtsAdapter;
  getTtsModelPaths(): unknown;
}

export interface SaxWhisperModule {
  createWhisperTranscriber(paths: unknown): OfflineTranscriber;
  getWhisperModelPaths(): unknown;
}

export interface VoiceTurnRunner {
  (input: {
    sessionId: string;
    text: string;
    history: ReadonlyArray<ChatMessage>;
    signal: AbortSignal;
    onDelta(t: string): void;
  }): Promise<{ assistantText: string; updatedHistory: ChatMessage[] }>;
}

export interface SaxBridgeContext {
  sessionId: string;
  emit(ev: VoiceEvent): void;
}

export interface OpenVoiceBridgeOptions {
  vad: SaxVadModule;
  stt: SaxSttModule;
  tts: SaxTtsModule;
  whisper: SaxWhisperModule;
  runTurn: VoiceTurnRunner;
  ackChirp?: VoiceSessionConfig["ackChirp"];
  overrides?: Partial<Pick<VoiceSessionConfig,
    "minUtteranceSamples" | "maxUtteranceSamples" | "prerollSamples" | "playbackTailMs"
  >>;
}

export function createOpenVoiceBridge(opts: OpenVoiceBridgeOptions): (ctx: SaxBridgeContext) => VoiceSession {
  const { vad, stt, tts, whisper, runTurn, ackChirp, overrides } = opts;
  const vadPaths = vad.getVadModelPaths();
  const sttPaths = stt.getSttModelPaths();
  const ttsPaths = tts.getTtsModelPaths();
  const whisperPaths = whisper.getWhisperModelPaths();

  return (ctx: SaxBridgeContext): VoiceSession => {
    return createVoiceSession({
      vadFactory: (cb) => vad.createStreamingVAD(vadPaths, {
        onSpeechStart: () => cb.onSpeechStart(),
        onSpeechEnd: () => cb.onSpeechEnd(),
        onError: (e) => cb.onError?.(e),
      }),
      sttFactory: (cb) => stt.createStreamingSTT(sttPaths, {
        onPartial: (t) => cb.onPartial(t),
        onFinal: (t) => cb.onFinal?.(t),
        onError: (e) => cb.onError?.(e),
      }),
      ttsFactory: (cb) => tts.createStreamingTTS(ttsPaths, {
        onAudio: (pcm, sr) => cb.onAudio(pcm, sr),
        onIdle: () => cb.onIdle(),
        onError: (e) => cb.onError?.(e),
      }),
      offlineFactory: () => whisper.createWhisperTranscriber(whisperPaths),
      llm: ({ text, history, signal, onDelta }) => runTurn({
        sessionId: ctx.sessionId,
        text,
        history,
        signal,
        onDelta,
      }),
      emit: ctx.emit,
      ackChirp,
      ...overrides,
    });
  };
}

export function isOpenVoiceBridgeEnabled(): boolean {
  return process.env.LAX_VOICE_OPEN === "1";
}
