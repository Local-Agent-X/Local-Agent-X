import { basename } from "node:path";
import { transcribeOggBuffer } from "../bridge-voice/index.js";
import { sendVoiceOrTextReply, type ReplyDeliveryProgress } from "../bridge-voice/reply.js";
import { getRuntimeConfig } from "../config.js";
import { apiCall, downloadTelegramFile, sendMessage, sendVoice } from "./api.js";
import { _voiceMirrorForChat, logger } from "./types.js";

/**
 * Detect voice/audio/photo/video/document messages, download the file, and
 * return a text description the agent can reason about. Returns empty string
 * if the message has nothing we know how to forward.
 */
export async function describeNonTextMessage(msg: any, token: string): Promise<string> {
  let fileId = ""; let kind = ""; let extra = "";
  if (msg.voice) { fileId = msg.voice.file_id; kind = "voice"; extra = `${msg.voice.duration || "?"}s, ${msg.voice.mime_type || "audio/ogg"}`; }
  else if (msg.audio) { fileId = msg.audio.file_id; kind = "audio"; extra = `${msg.audio.duration || "?"}s, ${msg.audio.mime_type || "audio/mpeg"}, title=${msg.audio.title || "?"}`; }
  else if (msg.video) { fileId = msg.video.file_id; kind = "video"; extra = `${msg.video.duration || "?"}s, ${msg.video.mime_type || "video/mp4"}, ${msg.video.width}x${msg.video.height}`; }
  else if (msg.video_note) { fileId = msg.video_note.file_id; kind = "video_note"; extra = `${msg.video_note.duration || "?"}s`; }
  else if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) { const largest = msg.photo[msg.photo.length - 1]; fileId = largest.file_id; kind = "photo"; extra = `${largest.width}x${largest.height}`; }
  else if (msg.document) { fileId = msg.document.file_id; kind = "document"; extra = `${msg.document.mime_type || "unknown"}, ${msg.document.file_name || "unnamed"}`; }
  else if (msg.sticker) { fileId = msg.sticker.file_id; kind = "sticker"; extra = msg.sticker.emoji || ""; }

  if (!fileId) return "";
  try {
    const localPath = await downloadTelegramFile(token, fileId, kind);
    // Present the served /uploads URL (same convention web/mobile uploads + the
    // image/video tools use) as the reference the agent passes to tools — a raw
    // local path can't be fetched by generate_video/generate_image (xAI side) and
    // trips the attachment-egress gate. Keep the local path for local-only tools
    // (transcription, OCR) that read the file directly.
    const url = `http://127.0.0.1:${getRuntimeConfig().port}/uploads/${basename(localPath)}`;
    const caption = typeof msg.caption === "string" ? ` Caption: "${msg.caption}".` : "";
    return `[User sent a ${kind} message via Telegram. Reference URL: ${url} — pass THIS to media tools (generate_video / generate_image / view_image); a local path won't work for those. Local copy: ${localPath} (for transcription / OCR that read the file directly). Metadata: ${extra}.${caption} To hear what was said in a voice note, audio or video, call transcribe_media on the local copy; to SEE a video, call read_video_frames on it; to read text out of an image, call ocr.]`;
  } catch (e) {
    logger.error(`[telegram] Failed to download ${kind}:`, (e as Error).message);
    return `[User sent a ${kind} message via Telegram but download failed: ${(e as Error).message}. Tell the user you couldn't process it.]`;
  }
}

/**
 * Inbound voice transcription: download the OGG, run STT, return the
 * transcript (or empty string on any failure). Marks the chat as
 * voice-mirrored so the reply mirrors the channel for this turn.
 */
export async function transcribeInboundVoice(msg: any, token: string, chatId: string): Promise<string> {
  if (!msg.voice || !msg.voice.file_id) return "";
  try {
    const info = await apiCall(token, "getFile", { file_id: msg.voice.file_id });
    if (info.ok && info.result?.file_path) {
      const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
      const res = await fetch(fileUrl);
      if (res.ok) {
        const oggBuf = Buffer.from(await res.arrayBuffer());
        const transcript = await transcribeOggBuffer(oggBuf);
        if (transcript && transcript.trim()) {
          const text = transcript.trim();
          _voiceMirrorForChat.add(chatId);
          logger.info(`[telegram] transcribed voice (${oggBuf.length}B): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
          return text;
        }
      }
    }
  } catch (e) {
    logger.warn(`[telegram] voice transcribe failed: ${(e as Error).message}`);
  }
  return "";
}

/**
 * Send the agent's reply to a Telegram chat, by voice or by text
 * (bridge-voice/reply.ts decides and falls back). Voice mode is on when the
 * chat has /voice on, or when this turn answers a voice note.
 */
export async function dispatchReply(
  token: string,
  chatId: string,
  textForWire: string,
  speakable: string,
  progress?: ReplyDeliveryProgress,
): Promise<boolean> {
  return sendVoiceOrTextReply({
    platform: "telegram", chatId, mirrorVoice: _voiceMirrorForChat.has(chatId), textForWire, speakable, progress,
    sendText: (text, prefix) => sendMessage(token, chatId, text, {
      prefix, isComplete: progress?.isDeliveryPartComplete, acknowledge: progress?.acknowledgeDeliveryPart,
    }),
    sendVoice: (ogg) => sendVoice(token, chatId, ogg),
  });
}
