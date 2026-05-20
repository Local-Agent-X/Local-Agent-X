// POST /api/voice/dictate-once — one-shot Whisper transcription.
//
// Electron (and any browser without webkitSpeechRecognition) can't use the
// in-renderer dictate path because Chromium-in-Electron lacks the Google
// Speech key. Renderer records a MediaRecorder blob, POSTs the bytes raw,
// gets `{ text }` back. Reuses the cached transcriber from bridge-voice so
// the model only loads once across the bridges + dictate code paths.

import type { IncomingMessage } from "node:http";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, safeErrorMessage } from "../../server-utils.js";
import { transcribeOggBuffer } from "../../bridge-voice/stt-helper.js";
import { isFfmpegAvailable } from "../../bridge-voice/audio-codec.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.voice-dictate");

// Cap at 25MB. WebM/Opus at MediaRecorder defaults (~32-48kbps) gives roughly
// 60-100 minutes of audio per 25MB — far past any reasonable single dictate.
// Cutoff exists to keep a stuck recorder from streaming gigabytes.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) throw new Error(`audio body exceeds ${maxBytes} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export const handleVoiceDictateRoutes: RouteHandler = async (method, url, req, res) => {
  if (method === "POST" && url.pathname === "/api/voice/dictate-once") {
    if (!(await isFfmpegAvailable())) {
      jsonResponse(res, 503, {
        error: "ffmpeg not on PATH — required to decode the recorded audio for Whisper",
      }, req);
      return true;
    }

    let buf: Buffer;
    try {
      buf = await readBodyBuffer(req, MAX_AUDIO_BYTES);
    } catch (e) {
      jsonResponse(res, 413, { error: safeErrorMessage(e) }, req);
      return true;
    }

    if (buf.length === 0) {
      jsonResponse(res, 400, { error: "empty audio body" }, req);
      return true;
    }

    try {
      const text = await transcribeOggBuffer(buf);
      // transcribeOggBuffer returns null on hallucination, empty input,
      // model unavailable, or any decode failure — surface as empty string
      // rather than 500 so the UI can render "no speech detected" cleanly.
      jsonResponse(res, 200, { text: text ?? "" }, req);
      return true;
    } catch (e) {
      logger.error(`dictate transcribe failed: ${safeErrorMessage(e)}`);
      jsonResponse(res, 500, { error: safeErrorMessage(e) }, req);
      return true;
    }
  }

  return false;
};
