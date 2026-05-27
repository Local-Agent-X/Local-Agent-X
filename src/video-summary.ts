/**
 * Video Summarization — extracts keyframes and describes video content.
 * Uses ffmpeg for frame extraction, optionally sends to vision model for descriptions.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";

/** Safely parse a fraction string like "30000/1001" without eval() */
function parseFraction(s: string): number {
  const parts = s.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return den !== 0 ? num / den : 0;
  }
  return Number(s) || 0;
}

const TMP_DIR = join(getLaxDir(), "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

export interface VideoInfo {
  duration: number;       // seconds
  width: number;
  height: number;
  fps: number;
  codec: string;
  fileSize: number;
}

export interface Keyframe {
  index: number;
  timestamp: number;      // seconds
  image: Buffer;
  description?: string;
}

export interface VideoSummary {
  info: VideoInfo;
  keyframes: Keyframe[];
  summary?: string;
  processingMs: number;
}

export interface SummarizeOptions {
  /** Number of keyframes to extract. Default: 8 */
  numFrames?: number;
  /** Frame format. Default: jpg */
  format?: "jpg" | "png";
  /** Whether to describe frames using a vision model */
  describe?: boolean;
  /** Vision API key */
  apiKey?: string;
  /** Vision model to use */
  model?: string;
  /** Max dimension for extracted frames */
  maxDimension?: number;
}

/** Get video metadata using ffprobe */
export function getVideoInfo(videoPath: string): VideoInfo {
  if (!existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);

  const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", videoPath], {
    encoding: "utf-8",
    timeout: 10_000,
  });

  const data = JSON.parse(probe);
  const videoStream = data.streams?.find((s: any) => s.codec_type === "video");
  const format = data.format || {};

  return {
    duration: parseFloat(format.duration || "0"),
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    fps: parseFraction(videoStream?.r_frame_rate || "0"),
    codec: videoStream?.codec_name || "unknown",
    fileSize: parseInt(format.size || "0"),
  };
}

/** Extract keyframes at evenly-spaced intervals */
export function extractKeyframes(
  videoPath: string,
  options: SummarizeOptions = {},
): Keyframe[] {
  const numFrames = options.numFrames ?? 8;
  const format = options.format ?? "jpg";
  const maxDim = options.maxDimension ?? 720;

  const info = getVideoInfo(videoPath);
  if (info.duration === 0) throw new Error("Cannot determine video duration");

  const frameDir = join(TMP_DIR, `frames_${randomBytes(6).toString("hex")}`);
  mkdirSync(frameDir, { recursive: true });

  try {
    // Calculate timestamps for evenly-spaced frames
    const interval = info.duration / (numFrames + 1);
    const timestamps = Array.from({ length: numFrames }, (_, i) => (i + 1) * interval);

    const keyframes: Keyframe[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const outPath = join(frameDir, `frame_${i}.${format}`);

      const scaleFilter = info.width > info.height
        ? `scale=${maxDim}:-2`
        : `scale=-2:${maxDim}`;

      try {
        execFileSync("ffmpeg", ["-ss", ts.toFixed(2), "-i", videoPath, "-frames:v", "1", "-vf", scaleFilter, "-y", outPath], {
          timeout: 10_000,
          stdio: "ignore",
        });

        if (existsSync(outPath)) {
          keyframes.push({
            index: i,
            timestamp: Math.round(ts * 100) / 100,
            image: readFileSync(outPath),
          });
        }
      } catch {
        // Skip frames that fail to extract
      }
    }

    return keyframes;
  } finally {
    // Clean up frame directory
    try {
      for (const f of readdirSync(frameDir)) {
        try { unlinkSync(join(frameDir, f)); } catch {}
      }
      rmdirSync(frameDir);
    } catch {}
  }
}

/** Describe a keyframe using a vision API */
async function describeFrame(
  image: Buffer,
  timestamp: number,
  apiKey: string,
  model: string,
): Promise<string> {
  const b64 = image.toString("base64");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 150,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: `Describe this video frame at ${timestamp.toFixed(1)}s in one sentence. Focus on key visual content.` },
        ],
      }],
    }),
  });

  if (!resp.ok) return "(description unavailable)";
  const data = await resp.json() as any;
  return data.content?.[0]?.text ?? "";
}

/** Full video summarization pipeline */
export async function summarizeVideo(
  videoPath: string,
  options: SummarizeOptions = {},
): Promise<VideoSummary> {
  const start = Date.now();
  const info = getVideoInfo(videoPath);
  const keyframes = extractKeyframes(videoPath, options);

  // Optionally describe frames with vision model
  if (options.describe) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    const model = options.model ?? "claude-sonnet-4-20250514";

    if (apiKey) {
      // Describe frames in parallel (batch of 4)
      for (let i = 0; i < keyframes.length; i += 4) {
        const batch = keyframes.slice(i, i + 4);
        const descriptions = await Promise.all(
          batch.map((kf) => describeFrame(kf.image, kf.timestamp, apiKey, model)),
        );
        batch.forEach((kf, j) => { kf.description = descriptions[j]; });
      }
    }
  }

  // Generate text summary from frame descriptions
  let summary: string | undefined;
  const descriptions = keyframes.map((kf) => kf.description).filter(Boolean);
  if (descriptions.length > 0) {
    const mins = Math.floor(info.duration / 60);
    const secs = Math.round(info.duration % 60);
    summary = `Video (${mins}m${secs}s, ${info.width}x${info.height}, ${info.codec}):\n` +
      descriptions.map((d, i) => `  [${keyframes[i].timestamp.toFixed(1)}s] ${d}`).join("\n");
  }

  return {
    info,
    keyframes,
    summary,
    processingMs: Date.now() - start,
  };
}

/** Quick summary — returns just the text description */
export async function quickSummary(videoPath: string): Promise<string> {
  const result = await summarizeVideo(videoPath, { describe: true, numFrames: 5, maxDimension: 512 });
  return result.summary ?? `Video: ${result.info.duration.toFixed(1)}s, ${result.keyframes.length} keyframes extracted`;
}
