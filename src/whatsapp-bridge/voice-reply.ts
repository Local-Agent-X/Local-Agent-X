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
import { synthesize } from "../voice/index.js";
import type { BridgeReply } from "./types.js";
import { splitMessage } from "./text-utils.js";

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
): Promise<boolean> {
  const { text: textForWire } = reply;
  const speakable = reply.speakable ?? reply.text;
  const sendText = async (text: string, prefix: string): Promise<boolean> => {
    const chunks = splitMessage(text, 4000);
    for (let index = 0; index < chunks.length; index++) {
      const part = `${prefix}:${index}`;
      if (reply.isDeliveryPartComplete?.(part)) continue;
      if (!(await deps.sendToJid(jid, chunks[index]))) return false;
      await reply.acknowledgeDeliveryPart?.(part);
    }
    return true;
  };
  let plan = reply.readDeliveryPlan?.();
  if (!plan) {
    const wantVoice = getVoicePref("whatsapp", phone) || _voiceMirrorForPhone.has(phone);
    plan = { mode: wantVoice ? "voice" : "text" };
    await reply.writeDeliveryPlan?.(plan);
  }
  if (plan.mode === "text") {
    return sendText(textForWire, "text");
  }

  const sendWithHintOnce = async (text: string, hint: string): Promise<boolean> => {
    if (_voiceFailHintSentByPhone.has(phone)) {
      return sendText(text, "fallback-text");
    }
    const sent = await sendText(`${text}\n\n— ${hint}`, "fallback-text");
    if (sent) _voiceFailHintSentByPhone.add(phone);
    return sent;
  };

  const sendDurableFallback = async (hint: string): Promise<boolean> => {
    if (plan?.mode !== "fallback") {
      const includeHint = !_voiceFailHintSentByPhone.has(phone);
      plan = { mode: "fallback", fallbackText: includeHint ? `${textForWire}\n\n--- ${hint}` : textForWire };
      await reply.writeDeliveryPlan?.(plan);
    }
    const sent = await sendText(plan.fallbackText ?? textForWire, "fallback-text");
    if (sent && plan.fallbackText !== textForWire) _voiceFailHintSentByPhone.add(phone);
    return sent;
  };

  if (plan.mode === "fallback") {
    return sendDurableFallback("Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.");
  }

  if (!(await isFfmpegAvailable())) {
    logger.warn("[whatsapp] voice reply requested but ffmpeg unavailable — sending text");
    return sendDurableFallback("Voice replies need ffmpeg installed on the server. Falling back to text until that's fixed.");
  }

  const chunks = splitForVoiceChunks(speakable, 3000);
  let allSent = true;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const part = `voice:${index}`;
    if (reply.isDeliveryPartComplete?.(part)) continue;
    try {
      const wav = await synthesize(chunk);
      const ogg = await encodeWavToOgg(wav);
      const ok = await deps.sendVoiceToJid(jid, ogg);
      if (ok) {
        await reply.acknowledgeDeliveryPart?.(part);
        continue;
      }
      logger.warn("[whatsapp] sendVoice returned false on chunk — bailing to text fallback");
      allSent = false;
      break;
    } catch (e) {
      logger.warn(`[whatsapp] voice synthesis failed on chunk: ${(e as Error).message} — bailing to text fallback`);
      allSent = false;
      break;
    }
  }
  if (!allSent) {
    return sendDurableFallback("Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.");
  }
  return true;
}
