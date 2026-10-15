// Voice control, carried on the `voice` data channel of the voice peer (link.ts). The
// audio rides that peer's media track both ways; these JSON frames are the control
// plane. The phone opens a session with `hello`, the desktop answers `ready`, then
// streams transcript, reply and playback events.

import { asNumber, asRecord, asString } from "./guards.js";

/** "chat" runs speech-to-text, the agent and text-to-speech; "dictate" only transcribes. */
export type VoiceMode = "chat" | "dictate";

// ── phone → desktop ──

/** Opens the session. Speech-to-text runs on the desktop unless `clientStt`. */
export type VoiceHelloFrame = { type: "hello"; sessionId: string; mode: VoiceMode; clientStt: boolean };
/** Change the voice or speaking speed mid-session. */
export type VoiceSettingsFrame = { type: "voice_settings"; voice?: string; speed?: number };
/** End of speech: flush the streaming transcriber. */
export type VoiceEosFrame = { type: "eos" };
/** A transcript the client produced itself (client-side speech-to-text). Absent
 *  `isFinal` means final. */
export type VoiceTranscriptFrame = { type: "transcript"; text: string; isFinal?: boolean };
/** Close the session. */
export type VoiceByeFrame = { type: "bye" };

export type VoiceControlFrame = VoiceHelloFrame | VoiceSettingsFrame | VoiceEosFrame | VoiceTranscriptFrame | VoiceByeFrame;

// ── desktop → phone ──

export type VoiceVisualKind = "emoji" | "text" | "shape" | "mood";

export type VoiceServerEvent =
  /** The session opened. */
  | { type: "ready"; sessionId: string; mode: VoiceMode }
  /** The voice stack is up; inbound speech audio is at `ttsSampleRate` (0 = none). */
  | { type: "voice_ready"; ttsSampleRate: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; sttMs?: number }
  | { type: "agent_start" }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; text: string }
  /** The reply was cut off by the user speaking over it. */
  | { type: "assistant_interrupted" }
  | { type: "vad_speech_start" }
  | { type: "vad_speech_end" }
  /** Drop any buffered speech audio (barge-in). */
  | { type: "tts_interrupt" }
  | { type: "tts_idle" }
  | { type: "playback_complete" }
  | { type: "agent_error" | "voice_error"; message: string }
  /** Decoration only: morph the voice visual, hold, return. */
  | { type: "visual"; kind: VoiceVisualKind; value: string; durationMs?: number };

// ── builders ──

export function buildVoiceHello(sessionId: string, mode: VoiceMode): VoiceHelloFrame {
  return { type: "hello", sessionId, mode, clientStt: false };
}

// ── parsers: null for anything malformed or unmodeled, so the receiver drops it ──

const asMode = (v: unknown): VoiceMode => (v === "dictate" ? "dictate" : "chat");

/** A control frame from the phone, as the desktop reads it. */
export function parseVoiceControl(raw: unknown): VoiceControlFrame | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "hello": {
      const sessionId = asString(msg.sessionId);
      return sessionId === null || sessionId === ""
        ? null
        : { type: "hello", sessionId, mode: asMode(msg.mode), clientStt: msg.clientStt === true };
    }
    case "voice_settings": {
      const frame: VoiceSettingsFrame = { type: "voice_settings" };
      const voice = asString(msg.voice);
      if (voice !== null) frame.voice = voice;
      const speed = asNumber(msg.speed);
      if (speed !== null) frame.speed = speed;
      return frame;
    }
    case "eos":
      return { type: "eos" };
    case "transcript": {
      const text = asString(msg.text);
      return text === null || text === "" ? null : { type: "transcript", text, isFinal: msg.isFinal !== false };
    }
    case "bye":
      return { type: "bye" };
    default:
      return null;
  }
}

/** An event from the desktop, as the phone reads it. */
export function parseVoiceEvent(raw: unknown): VoiceServerEvent | null {
  const msg = asRecord(raw);
  if (msg === null) return null;
  switch (msg.type) {
    case "ready": {
      const sessionId = asString(msg.sessionId);
      return sessionId === null ? null : { type: "ready", sessionId, mode: asMode(msg.mode) };
    }
    case "voice_ready":
      return { type: "voice_ready", ttsSampleRate: asNumber(msg.ttsSampleRate) ?? 0 };
    case "partial":
    case "assistant_delta": {
      const text = asString(msg.text);
      return text === null ? null : { type: msg.type, text };
    }
    case "final": {
      const text = asString(msg.text);
      if (text === null) return null;
      const sttMs = asNumber(msg.sttMs);
      return sttMs === null ? { type: "final", text } : { type: "final", text, sttMs };
    }
    case "assistant_done":
      return { type: "assistant_done", text: asString(msg.text) ?? "" };
    case "agent_start":
    case "assistant_interrupted":
    case "vad_speech_start":
    case "vad_speech_end":
    case "tts_interrupt":
    case "tts_idle":
    case "playback_complete":
      return { type: msg.type };
    case "agent_error":
    case "voice_error":
      return { type: msg.type, message: asString(msg.message) ?? "The voice pipeline hit an error." };
    case "visual": {
      const kind = msg.kind;
      const value = asString(msg.value);
      if (value === null || (kind !== "emoji" && kind !== "text" && kind !== "shape" && kind !== "mood")) return null;
      const durationMs = asNumber(msg.durationMs);
      return durationMs === null ? { type: "visual", kind, value } : { type: "visual", kind, value, durationMs };
    }
    default:
      return null;
  }
}
