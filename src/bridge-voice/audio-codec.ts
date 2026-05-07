// Audio codec helpers for the messaging bridges.
//
// Telegram and WhatsApp deliver voice notes as OGG/Opus and expect the same
// container for outbound voice notes. Whisper (sherpa-onnx) wants 16 kHz mono
// PCM16; our offline TTS produces 24 kHz mono WAV. We shell out to ffmpeg
// for both directions — it's already a runtime dependency elsewhere in the
// codebase and is cheap to invoke per message.
//
// LAX_FFMPEG honours the existing override used by the voice stack.

import { spawn } from "node:child_process";

import { createLogger } from "../logger.js";
const logger = createLogger("bridge-voice.audio-codec");

const FFMPEG = process.env.LAX_FFMPEG || "ffmpeg";

function runFfmpeg(args: string[], stdin: Buffer | null, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(new Error(`spawn ffmpeg failed: ${(e as Error).message}`));
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn error: ${e.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    if (stdin) {
      proc.stdin.on("error", () => { /* swallow EPIPE if ffmpeg closed early */ });
      proc.stdin.end(stdin);
    } else {
      proc.stdin.end();
    }
  });
}

/**
 * Decode an OGG/Opus (or any ffmpeg-readable) buffer into 16 kHz mono PCM16.
 * Returns an Int16Array suitable for `WhisperTranscriber.transcribe`.
 * Throws if ffmpeg is missing or the input can't be decoded.
 */
export async function decodeOggToPcm16(buf: Buffer): Promise<Int16Array> {
  if (!buf || buf.length === 0) throw new Error("empty audio buffer");
  const out = await runFfmpeg(
    ["-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "s16le", "-loglevel", "error", "pipe:1"],
    buf,
    30_000,
  );
  if (out.length === 0) throw new Error("ffmpeg produced no PCM output");
  // Re-cast the byte buffer as Int16 samples. Pad odd byte if needed.
  const aligned = out.length % 2 === 0 ? out : out.subarray(0, out.length - 1);
  return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
}

/**
 * Encode a WAV buffer (any sample rate, ffmpeg figures it out) to OGG/Opus
 * suitable for sending as a Telegram / WhatsApp voice note. 48 kHz mono,
 * 32 kbps — the standard config for voice notes on both platforms.
 */
export async function encodeWavToOgg(buf: Buffer): Promise<Buffer> {
  if (!buf || buf.length === 0) throw new Error("empty WAV buffer");
  return runFfmpeg(
    ["-i", "pipe:0", "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "-loglevel", "error", "pipe:1"],
    buf,
    30_000,
  );
}

/** Quick check whether ffmpeg is available on PATH. Cached. */
let _ffmpegAvailable: boolean | null = null;
export async function isFfmpegAvailable(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  try {
    await runFfmpeg(["-version", "-loglevel", "error"], null, 5_000);
    _ffmpegAvailable = true;
  } catch (e) {
    logger.warn(`ffmpeg not available: ${(e as Error).message}`);
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}
