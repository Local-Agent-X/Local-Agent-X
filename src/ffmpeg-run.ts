/**
 * Canonical ffmpeg/ffprobe *invocation* — the sibling of ffmpeg-bin.ts, which
 * owns binary *resolution*. Every caller that spawns ffmpeg goes through
 * runFfmpeg so the timeout, SIGKILL-on-hang, EPIPE-swallow and stderr-capture
 * behavior is written once.
 *
 * Extracted from bridge-voice/audio-codec.ts when a second consumer (media
 * transcription + video frame sampling) needed the same spawn semantics.
 */

import { spawn } from "node:child_process";

import { createLogger } from "./logger.js";
import { ffmpegBin, ffprobeBin } from "./ffmpeg-bin.js";

const logger = createLogger("ffmpeg-run");

function run(bin: string, args: string[], stdin: Buffer | null, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
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

export function runFfmpeg(args: string[], stdin: Buffer | null, timeoutMs: number): Promise<Buffer> {
  return run(ffmpegBin(), args, stdin, timeoutMs);
}

/** Quick check whether ffmpeg is available. Cached. */
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

export interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * Probe a media file's duration and which streams it carries. Duration is 0
 * when the container doesn't declare one (some streamed/partial files) —
 * callers that segment by time must treat 0 as "unknown", not "empty".
 */
export function parseProbeOutput(text: string): MediaProbe {
  const durationMatch = /^duration=([0-9.]+)\s*$/m.exec(text);
  const duration = durationMatch ? Number(durationMatch[1]) : NaN;
  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasVideo: /^codec_type=video\s*$/m.test(text),
    hasAudio: /^codec_type=audio\s*$/m.test(text),
  };
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const out = await run(ffprobeBin(), [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "default=noprint_wrappers=1",
    path,
  ], null, 30_000);
  return parseProbeOutput(out.toString("utf8"));
}
