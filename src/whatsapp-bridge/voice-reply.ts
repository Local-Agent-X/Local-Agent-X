// Voice-vs-text reply dispatcher. Two pieces of per-process state:
//
//   markVoiceMirror(phone): one-shot — when the inbound was a voice note,
//     the reply for THAT turn goes back as voice regardless of the /voice
//     toggle. Cleared in the caller's finally.
//
//   _voiceFailHintSentByPhone: tracks chats we've already told "voice
//     engine is down" so the hint only fires once per server-uptime per
//     phone. Resets on server restart so a fresh boot re-arms.
//
// Voice mode is active when the user has /voice on OR this turn was
// triggered by an inbound voice note. Any TTS / encode / sendVoice
// failure falls back to text so the user always receives the reply.
//
// Long replies are chunked on paragraph/sentence boundaries and sent as
// separate voice notes (~2-3 min each). Replaces the prior "first
// sentence audio + rest as text" which broke the "transcribe this
// report so I can listen" intent.

import { createLogger } from "../logger.js";
import { encodeWavToOgg, isFfmpegAvailable, getVoicePref, splitForVoiceChunks } from "../bridge-voice/index.js";
import { synthesize } from "../voice.js";
import type { BridgeReply } from "./types.js";

const logger = createLogger("whatsapp-bridge");

const _voiceMirrorForPhone = new Set<string>();
const _voiceFailHintSentByPhone = new Set<string>();

/** Mark a phone for voice-mirror reply on the next turn. */
export function markVoiceMirror(phone: string): void {
  _voiceMirrorForPhone.add(phone);
}

/** Clear the one-shot voice-mirror flag — call from a finally block. */
export function clearVoiceMirror(phone: string): void {
  _voiceMirrorForPhone.delete(phone);
}

export interface VoiceReplyDeps {
  sendToJid: (jid: string, text: string) => Promise<boolean>;
  sendVoiceToJid: (jid: string, ogg: Buffer) => Promise<boolean>;
}

export async function dispatchReplyToJid(
  deps: VoiceReplyDeps,
  jid: string,
  phone: string,
  reply: BridgeReply,
): Promise<void> {
  const { text: textForWire } = reply;
  const speakable = reply.speakable ?? reply.text;
  const wantVoice = getVoicePref("whatsapp", phone) || _voiceMirrorForPhone.has(phone);
  if (!wantVoice) {
    await deps.sendToJid(jid, textForWire);
    return;
  }

  const sendWithHintOnce = async (text: string, hint: string) => {
    if (_voiceFailHintSentByPhone.has(phone)) {
      await deps.sendToJid(jid, text);
      return;
    }
    _voiceFailHintSentByPhone.add(phone);
    await deps.sendToJid(jid, `${text}\n\n— ${hint}`);
  };

  if (!(await isFfmpegAvailable())) {
    logger.warn("[whatsapp] voice reply requested but ffmpeg unavailable — sending text");
    await sendWithHintOnce(textForWire, "Voice replies need ffmpeg installed on the server. Falling back to text until that's fixed.");
    return;
  }

  const chunks = splitForVoiceChunks(speakable, 3000);
  let anySent = false;
  for (const chunk of chunks) {
    try {
      const wav = await synthesize(chunk);
      const ogg = await encodeWavToOgg(wav);
      const ok = await deps.sendVoiceToJid(jid, ogg);
      if (ok) { anySent = true; continue; }
      logger.warn("[whatsapp] sendVoice returned false on chunk — bailing to text fallback");
      break;
    } catch (e) {
      logger.warn(`[whatsapp] voice synthesis failed on chunk: ${(e as Error).message} — bailing to text fallback`);
      break;
    }
  }
  if (!anySent) {
    await sendWithHintOnce(textForWire, "Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.");
  }
}
