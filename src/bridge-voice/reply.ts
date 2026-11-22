// A messaging bridge's reply, by voice or by text.
//
// Voice is used when the chat has /voice on, or when this turn answers a voice
// note (mirror the channel for that one reply). A long reply is split at
// paragraph and sentence boundaries into several voice notes (~2-3 min each),
// so a "read me this report" reply is audible in full. Any TTS, encode or
// send-voice failure falls back to the text, so the user always gets the reply;
// the fallback and the choice of voice or text are written to the delivery
// plan, so a transport retry resumes the same wire plan and resends no part
// the provider already took.
//
// Telegram and WhatsApp each carried this, line for line. The channel supplies
// only how it sends: its text sender (with its own chunking) and its voice
// sender.
import { createLogger } from "../logger.js";
import { synthesize } from "../voice/index.js";
import { encodeWavToOgg, getVoicePref, isFfmpegAvailable, splitForVoiceChunks, type BridgePlatform } from "./index.js";
import type { DurableInboundDeliveryPlan } from "../server/inbound-delivery-store.js";

const logger = createLogger("bridge-voice.reply");

/** Longest text spoken as one voice note (~2-3 min of audio): short enough to
 *  load on a slow connection. */
const VOICE_NOTE_MAX_CHARS = 3000;

const ENGINE_DOWN_HINT = "Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.";
const NO_FFMPEG_HINT = "Voice replies need ffmpeg installed on the server. Falling back to text until that's fixed.";

// Chats already told "voice is down", so the hint goes out once per chat per
// server run and not on every reply while the engine is offline.
const voiceFailHintSent = new Set<string>();

/** What a durable inbound delivery lets a reply resume from. */
export interface ReplyDeliveryProgress {
  isDeliveryPartComplete?: (part: string) => boolean;
  acknowledgeDeliveryPart?: (part: string) => Promise<void>;
  readDeliveryPlan?: () => DurableInboundDeliveryPlan | undefined;
  writeDeliveryPlan?: (plan: DurableInboundDeliveryPlan) => Promise<void>;
}

export interface VoiceOrTextReply {
  platform: BridgePlatform;
  /** The chat, as its voice preference is keyed (a Telegram chat id, a phone). */
  chatId: string;
  /** This turn answers a voice note: reply by voice whatever the preference. */
  mirrorVoice: boolean;
  textForWire: string;
  speakable: string;
  /** Sends text the channel's way; `prefix` names its parts in the delivery progress. */
  sendText: (text: string, prefix: string) => Promise<boolean>;
  sendVoice: (ogg: Buffer) => Promise<boolean>;
  progress?: ReplyDeliveryProgress;
}

/** Send the reply. True when every part of it reached the channel. */
export async function sendVoiceOrTextReply(reply: VoiceOrTextReply): Promise<boolean> {
  const { platform, textForWire, progress } = reply;
  const chat = `${platform}:${reply.chatId}`;
  let plan = progress?.readDeliveryPlan?.();
  if (!plan) {
    const wantVoice = getVoicePref(platform, reply.chatId) || reply.mirrorVoice;
    plan = { mode: wantVoice ? "voice" : "text" };
    await progress?.writeDeliveryPlan?.(plan);
  }
  if (plan.mode === "text") return reply.sendText(textForWire, "text");

  const sendDurableFallback = async (hint: string): Promise<boolean> => {
    if (plan?.mode !== "fallback") {
      const includeHint = !voiceFailHintSent.has(chat);
      plan = { mode: "fallback", fallbackText: includeHint ? `${textForWire}\n\n--- ${hint}` : textForWire };
      await progress?.writeDeliveryPlan?.(plan);
    }
    const sent = await reply.sendText(plan.fallbackText ?? textForWire, "fallback-text");
    if (sent && plan.fallbackText !== textForWire) voiceFailHintSent.add(chat);
    return sent;
  };

  if (plan.mode === "fallback") return sendDurableFallback(ENGINE_DOWN_HINT);

  if (!(await isFfmpegAvailable())) {
    logger.warn(`[${platform}] voice reply requested but ffmpeg unavailable — sending text`);
    return sendDurableFallback(NO_FFMPEG_HINT);
  }

  const chunks = splitForVoiceChunks(reply.speakable, VOICE_NOTE_MAX_CHARS);
  for (let index = 0; index < chunks.length; index++) {
    const part = `voice:${index}`;
    if (progress?.isDeliveryPartComplete?.(part)) continue;
    try {
      const ogg = await encodeWavToOgg(await synthesize(chunks[index]));
      if (!(await reply.sendVoice(ogg))) {
        logger.warn(`[${platform}] sendVoice returned false on chunk — bailing to text fallback`);
        return sendDurableFallback(ENGINE_DOWN_HINT);
      }
      await progress?.acknowledgeDeliveryPart?.(part);
    } catch (e) {
      logger.warn(`[${platform}] voice synthesis failed on chunk: ${(e as Error).message} — bailing to text fallback`);
      return sendDurableFallback(ENGINE_DOWN_HINT);
    }
  }
  return true;
}
