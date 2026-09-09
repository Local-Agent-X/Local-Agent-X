/**
 * Video frame sampling engine — evenly spaced stills from a video, handed to
 * the same vision path a still image takes.
 *
 * The tool definition and its path gate live in vision-tools.ts; this module
 * only ever sees a path the security layer already validated, mirroring the
 * ocr-tool.ts split.
 *
 * One ffmpeg invocation per frame, each with `-ss` BEFORE `-i` (fast keyframe
 * seek) so sampling the last frame of a two-hour file costs the same as the
 * first. A single-pass `fps` filter would decode everything in between.
 */

import { runFfmpeg, probeMedia, isFfmpegAvailable } from "../ffmpeg-run.js";
import { createLogger } from "../logger.js";

const logger = createLogger("tools.video-frames");

export const MAX_FRAMES = 12;
export const DEFAULT_FRAMES = 6;

/** Vision models gain nothing from more than this, and every extra pixel is
 *  base64 in the model's context window. */
const MAX_WIDTH = 1024;

export interface VideoFrame {
  atSec: number;
  jpeg: Buffer;
}

export interface FrameSample {
  frames: VideoFrame[];
  durationSec: number;
}

async function grabFrame(path: string, atSec: number): Promise<Buffer> {
  return runFfmpeg([
    "-ss", String(atSec),
    "-i", path,
    "-frames:v", "1",
    // -2 keeps the height even (mjpeg requires it) while preserving aspect.
    "-vf", `scale='min(${MAX_WIDTH},iw)':-2`,
    "-f", "image2",
    "-c:v", "mjpeg",
    "-q:v", "4",
    "-loglevel", "error",
    "pipe:1",
  ], null, 60_000);
}

export async function sampleVideoFrames(path: string, count: number): Promise<FrameSample> {
  if (!(await isFfmpegAvailable())) {
    throw new Error("ffmpeg is not available — it ships with the app and via ffmpeg-static; set LAX_FFMPEG to override");
  }

  const probe = await probeMedia(path);
  if (!probe.hasVideo) throw new Error("this file has no video track");

  const wanted = Math.min(MAX_FRAMES, Math.max(1, Math.floor(count)));

  // Sample at window midpoints: the first frame of a video is routinely a
  // black or title frame, and the last is often a fade-out.
  const timestamps = probe.durationSec > 0
    ? Array.from({ length: wanted }, (_, i) => (probe.durationSec * (i + 0.5)) / wanted)
    : [0];

  const frames: VideoFrame[] = [];
  for (const atSec of timestamps) {
    const jpeg = await grabFrame(path, atSec);
    // A seek past the last decodable packet yields no bytes rather than an
    // error; skipping keeps a slightly-over-declared duration from failing.
    if (jpeg.length > 0) frames.push({ atSec, jpeg });
  }

  if (frames.length === 0) throw new Error("ffmpeg decoded no frames from this file");

  logger.info(`[read_video_frames] ${path} → ${frames.length}/${wanted} frame(s)`);
  return { frames, durationSec: probe.durationSec };
}
