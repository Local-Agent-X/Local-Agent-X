import { encodeWavToOgg, isFfmpegAvailable, transcribeOggBuffer, getVoicePref, splitForVoiceChunks } from "../bridge-voice/index.js";
import { synthesize } from "../voice.js";
import { apiCall, downloadTelegramFile, sendMessage, sendVoice } from "./api.js";
import { _voiceFailHintSent, _voiceMirrorForChat, logger } from "./types.js";

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
    const caption = typeof msg.caption === "string" ? ` Caption: "${msg.caption}".` : "";
    return `[User sent a ${kind} message via Telegram. Saved locally at ${localPath}. Metadata: ${extra}.${caption} If handling this requires a capability you don't have yet (transcription, OCR, video analysis), use self_edit to add it — then re-read this file.]`;
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
 * Send the agent's reply, choosing voice vs text per-chat. Voice mode is
 * active when the user has /voice on, OR when this turn was triggered by
 * an inbound voice note (mirror-the-channel for that one reply).
 *
 * Long replies in voice mode: send the FIRST sentence as a voice note,
 * then the full text as a follow-up message. Voice notes much over a
 * minute feel obnoxious in messaging apps.
 *
 * Failure paths: any TTS / encode / send-voice failure falls back to
 * sendMessage(text) so the user always gets the reply.
 */
export async function dispatchReply(token: string, chatId: string, textForWire: string, speakable: string): Promise<void> {
  const wantVoice = getVoicePref("telegram", chatId) || _voiceMirrorForChat.has(chatId);
  if (!wantVoice) {
    await sendMessage(token, chatId, textForWire);
    return;
  }

  const sendWithHintOnce = async (text: string, hint: string) => {
    if (_voiceFailHintSent.has(chatId)) {
      await sendMessage(token, chatId, text);
      return;
    }
    _voiceFailHintSent.add(chatId);
    await sendMessage(token, chatId, `${text}\n\n— ${hint}`);
  };

  if (!(await isFfmpegAvailable())) {
    logger.warn("[telegram] voice reply requested but ffmpeg unavailable — sending text");
    await sendWithHintOnce(textForWire, "Voice replies need ffmpeg installed on the server. Falling back to text until that's fixed.");
    return;
  }

  // Voice-only mode: split long replies into multiple voice notes at
  // paragraph/sentence boundaries. The previous "speak first sentence,
  // send rest as text" was wrong for the "transcribe this report so I
  // can listen" use case — user wanted the WHOLE thing audible.
  // Telegram voice notes hold ~50MB / over an hour at Opus, so we have
  // huge headroom. Cap each chunk at 3000 chars (~2-3 min audio) to
  // keep individual notes loadable on slow connections.
  const chunks = splitForVoiceChunks(speakable, 3000);
  let anySent = false;
  for (const chunk of chunks) {
    try {
      const wav = await synthesize(chunk);
      const ogg = await encodeWavToOgg(wav);
      const ok = await sendVoice(token, chatId, ogg);
      if (ok) { anySent = true; continue; }
      logger.warn("[telegram] sendVoice returned false on chunk — bailing to text fallback");
      break;
    } catch (e) {
      logger.warn(`[telegram] voice synthesis failed on chunk: ${(e as Error).message} — bailing to text fallback`);
      break;
    }
  }
  if (!anySent) {
    await sendWithHintOnce(textForWire, "Voice engine isn't reachable. Send /voice start lite to bring one up (cold start ~90-120s), then try again.");
  }
}
