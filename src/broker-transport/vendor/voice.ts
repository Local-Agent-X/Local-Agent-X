// Voice control, carried on the `voice` data channel of the voice peer (link.ts). The
// audio rides that peer's media track both ways; these JSON frames are the control
// plane. The phone opens a session with `hello`, the desktop answers `ready`, then
// streams transcript, reply and playback events.
//
// A photo or a camera frame is bigger than one data-channel message, so the channel is
// chunked like the chat channel (chunks.ts ChunkedLink): each end sends its link hello
// when the channel opens, and splits only for an end that sent one.

import type { ChatAttachment } from "./chat.js";
import { parseCard, type ChatCard } from "./card.js";
import { asNumber, asRecord, asString } from "./guards.js";

/** "chat" runs speech-to-text, the agent and text-to-speech; "dictate" only transcribes. */
export type VoiceMode = "chat" | "dictate";

// ── phone → desktop ──

/** Opens the session. Speech-to-text runs on the desktop unless `clientStt`. */
export type VoiceHelloFrame = { type: "hello"; sessionId: string; mode: VoiceMode; clientStt: boolean };
/** Change the voice or speaking speed mid-session. `remember`: the user picked this
 *  voice; it becomes their voice for every call, not just this one. */
export type VoiceSettingsFrame = { type: "voice_settings"; voice?: string; speed?: number; remember?: boolean };
/** End of speech: flush the streaming transcriber. */
export type VoiceEosFrame = { type: "eos" };
/** A transcript the client produced itself (client-side speech-to-text). Absent
 *  `isFinal` means final. */
export type VoiceTranscriptFrame = { type: "transcript"; text: string; isFinal?: boolean };
/** Close the session. */
export type VoiceByeFrame = { type: "bye" };
/** Photos or files the user shared on the call, the chat's attachment shape with the
 *  bytes inline (`dataUrl`; `url` is null, there is no upload step). They go to the
 *  agent with the next thing the user says. */
export type VoiceAttachFrame = { type: "attach"; attachments: ChatAttachment[] };
/** The phone's camera while the user has it open on the call: its latest frame (a
 *  data:image URL), sent every few seconds, or null when it closed. Each thing the user
 *  says while it is open goes to the agent with the latest frame, so it sees what they
 *  are pointing the camera at. */
export type VoiceCameraFrame = { type: "camera"; frame: string | null };
/** Stop the camera watch running on this call (the user closed the "watching for"
 *  indicator). The desktop answers with `camera_watch` watching null. */
export type VoiceCameraWatchStopFrame = { type: "camera_watch_stop" };

export type VoiceControlFrame =
  | VoiceHelloFrame
  | VoiceSettingsFrame
  | VoiceEosFrame
  | VoiceTranscriptFrame
  | VoiceByeFrame
  | VoiceAttachFrame
  | VoiceCameraFrame
  | VoiceCameraWatchStopFrame;

// ── desktop → phone ──

export type VoiceVisualKind = "emoji" | "text" | "shape" | "mood";

/** A voice the call can speak in: its id for `voice_settings`, its name, and the group
 *  a picker lists it under ("Your voices", "American", "British", ...). */
export type VoiceOption = { id: string; name: string; group: string };

export type VoiceServerEvent =
  /** The session opened. */
  | { type: "ready"; sessionId: string; mode: VoiceMode }
  /** The voice stack is up; inbound speech audio is at `ttsSampleRate` (0 = none). */
  | { type: "voice_ready"; ttsSampleRate: number }
  | { type: "partial"; text: string }
  /** What the user said, once they stop. `continues` marks words that carry on the
   *  message before them: a pause was read as its end, a reply started, and the user
   *  kept talking. `text` is the new words only; they join that message, and the
   *  reply the pause started is gone. */
  | { type: "final"; text: string; sttMs?: number; continues?: true }
  | { type: "agent_start" }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; text: string }
  /** The reply was cut off by the user speaking over it. */
  | { type: "assistant_interrupted" }
  | { type: "vad_speech_start" }
  | { type: "vad_speech_end" }
  /** Drop any buffered speech audio (barge-in). `continues`: the user spoke before
   *  they had heard the reply, so that reply is gone and what they say now carries on
   *  their last message: its live words belong in that message, and its `final` comes
   *  marked `continues` too. */
  | { type: "tts_interrupt"; continues?: true }
  | { type: "tts_idle" }
  | { type: "playback_complete" }
  /** The turn or the voice stack failed; the call can't go on as it was. */
  | { type: "agent_error" | "voice_error"; message: string }
  /** One stage failed and the call goes on: speech synthesis (tts), live transcription
   *  (stt), or the final transcription of an utterance (whisper, so that utterance is
   *  lost). Show it; don't end the call. */
  | { type: "tts_error" | "stt_error" | "whisper_error"; message: string }
  /** Decoration only: morph the voice visual, hold, return. */
  | { type: "visual"; kind: VoiceVisualKind; value: string; durationMs?: number }
  /** The voices this call can speak in, sent when it opens, and the user's voice now
   *  ("" when they never picked one: the desktop's default). */
  | { type: "voices"; voices: VoiceOption[]; current: string }
  /** A card the agent showed during the reply (card.ts): drawn in the chat, not spoken. */
  | { type: "card"; card: ChatCard }
  /** The agent is watching the call's camera for something ("the water is boiling"),
   *  to say so on the call when it sees it; null: it stopped (it saw it, the camera
   *  closed, time ran out, or it was cancelled). Sent whenever that changes. */
  | { type: "camera_watch"; watching: string | null };

// ── builders ──

export function buildVoiceHello(sessionId: string, mode: VoiceMode): VoiceHelloFrame {
  return { type: "hello", sessionId, mode, clientStt: false };
}

// ── parsers: null for anything malformed or unmodeled, so the receiver drops it ──

const asMode = (v: unknown): VoiceMode => (v === "dictate" ? "dictate" : "chat");

const DATA_URL = /^data:[^;,]+;base64,./;

/** An attachment with its bytes inline, or null. */
function asVoiceAttachment(v: unknown): ChatAttachment | null {
  const a = asRecord(v);
  if (a === null) return null;
  const name = asString(a.name);
  const type = asString(a.type);
  const dataUrl = asString(a.dataUrl);
  if (name === null || type === null || dataUrl === null || !DATA_URL.test(dataUrl)) return null;
  const isImage = typeof a.isImage === "boolean" ? a.isImage : type.startsWith("image/");
  return { name, size: asNumber(a.size) ?? 0, type, isImage, url: null, dataUrl };
}

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
      if (msg.remember === true) frame.remember = true;
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
    case "attach": {
      const list = Array.isArray(msg.attachments) ? msg.attachments.map(asVoiceAttachment) : [];
      const attachments = list.filter((a): a is ChatAttachment => a !== null);
      return attachments.length === 0 ? null : { type: "attach", attachments };
    }
    case "camera": {
      if (msg.frame === null) return { type: "camera", frame: null };
      const frame = asString(msg.frame);
      return frame !== null && frame.startsWith("data:image/") && DATA_URL.test(frame) ? { type: "camera", frame } : null;
    }
    case "camera_watch_stop":
      return { type: "camera_watch_stop" };
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
      return { type: "final", text, ...(sttMs === null ? {} : { sttMs }), ...(msg.continues === true ? { continues: true as const } : {}) };
    }
    case "assistant_done":
      return { type: "assistant_done", text: asString(msg.text) ?? "" };
    case "agent_start":
    case "assistant_interrupted":
    case "vad_speech_start":
    case "vad_speech_end":
    case "tts_idle":
    case "playback_complete":
      return { type: msg.type };
    case "tts_interrupt":
      return msg.continues === true ? { type: "tts_interrupt", continues: true } : { type: "tts_interrupt" };
    case "agent_error":
    case "voice_error":
      return { type: msg.type, message: asString(msg.message) ?? "The voice pipeline hit an error." };
    case "tts_error":
    case "stt_error":
    case "whisper_error":
      return { type: msg.type, message: asString(msg.message) ?? "The voice pipeline hit an error." };
    case "visual": {
      const kind = msg.kind;
      const value = asString(msg.value);
      if (value === null || (kind !== "emoji" && kind !== "text" && kind !== "shape" && kind !== "mood")) return null;
      const durationMs = asNumber(msg.durationMs);
      return durationMs === null ? { type: "visual", kind, value } : { type: "visual", kind, value, durationMs };
    }
    case "card": {
      const card = parseCard(msg.card);
      return card === null ? null : { type: "card", card };
    }
    case "camera_watch": {
      if (msg.watching === null) return { type: "camera_watch", watching: null };
      const watching = asString(msg.watching);
      return watching === null || watching.trim() === "" ? null : { type: "camera_watch", watching };
    }
    case "voices": {
      const voices = (Array.isArray(msg.voices) ? msg.voices : []).flatMap((v): VoiceOption[] => {
        const o = asRecord(v);
        const id = o === null ? null : asString(o.id);
        const name = o === null ? null : asString(o.name);
        return id === null || name === null ? [] : [{ id, name, group: (o !== null ? asString(o.group) : null) ?? "" }];
      });
      return { type: "voices", voices, current: asString(msg.current) ?? "" };
    }
    default:
      return null;
  }
}
