// WhatsApp's side of a voice-or-text reply (bridge-voice/reply.ts decides and
// falls back): how its text goes out in chunks, and one piece of per-process
// state.
//
//   markVoiceMirror(phone): one-shot — when the inbound was a voice note,
//     the reply for THAT turn goes back as voice regardless of the /voice
//     toggle. Cleared in the caller's finally.

import { sendVoiceOrTextReply } from "../bridge-voice/reply.js";
import type { BridgeReply } from "./types.js";
import { splitMessage } from "./text-utils.js";

const _voiceMirrorForPhone = new Set<string>();

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
  return sendVoiceOrTextReply({
    platform: "whatsapp", chatId: phone, mirrorVoice: _voiceMirrorForPhone.has(phone),
    textForWire: reply.text, speakable: reply.speakable ?? reply.text, progress: reply,
    sendText, sendVoice: (ogg) => deps.sendVoiceToJid(jid, ogg),
  });
}
