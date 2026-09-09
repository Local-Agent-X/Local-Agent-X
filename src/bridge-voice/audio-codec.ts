// Audio codec helpers.
//
// Telegram and WhatsApp deliver voice notes as OGG/Opus and expect the same
// container for outbound voice notes. Whisper (sherpa-onnx) wants 16 kHz mono
// PCM16; our offline TTS produces 24 kHz mono WAV. We shell out to ffmpeg
// for both directions — it's already a runtime dependency elsewhere in the
// codebase and is cheap to invoke per message.
//
// The spawn semantics (timeout, SIGKILL, stderr capture) live in
// ../ffmpeg-run.ts, shared with the media-transcription and frame-sampling
// paths.

import { runFfmpeg } from "../ffmpeg-run.js";

export { isFfmpegAvailable } from "../ffmpeg-run.js";

/** ffmpeg output spec for the 16 kHz mono PCM16 whisper expects. */
const PCM16_OUT = ["-ar", "16000", "-ac", "1", "-f", "s16le", "-loglevel", "error", "pipe:1"];

/** Re-cast an ffmpeg s16le byte buffer as Int16 samples, dropping an odd tail byte. */
function asPcm16(out: Buffer): Int16Array {
  const aligned = out.length % 2 === 0 ? out : out.subarray(0, out.length - 1);
  return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
}

/**
 * Decode an OGG/Opus (or any ffmpeg-readable) buffer into 16 kHz mono PCM16.
 * Returns an Int16Array suitable for `WhisperTranscriber.transcribe`.
 * Throws if ffmpeg is missing or the input can't be decoded.
 */
export async function decodeOggToPcm16(buf: Buffer): Promise<Int16Array> {
  if (!buf || buf.length === 0) throw new Error("empty audio buffer");
  const out = await runFfmpeg(["-i", "pipe:0", ...PCM16_OUT], buf, 30_000);
  if (out.length === 0) throw new Error("ffmpeg produced no PCM output");
  return asPcm16(out);
}

/**
 * Decode one time window of a media FILE's audio track into 16 kHz mono PCM16.
 * Takes a path rather than a buffer so an hours-long recording is never read
 * into memory whole — the caller walks the file a window at a time. `-vn`
 * drops the video track, so an mp4 works exactly like an mp3.
 *
 * `-ss` precedes `-i` deliberately: that is ffmpeg's fast (keyframe) seek, so
 * segment N doesn't cost a decode of segments 0..N-1.
 */
export async function decodeFileSegmentToPcm16(
  path: string,
  startSec: number,
  durationSec: number,
): Promise<Int16Array> {
  const out = await runFfmpeg([
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-i", path,
    "-vn",
    ...PCM16_OUT,
  ], null, 120_000);
  return asPcm16(out);
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
