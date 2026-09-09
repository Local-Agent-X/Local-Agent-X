/**
 * Timed-media perception — transcribe_media (what is SAID) and
 * read_video_frames (what is SHOWN). The two halves of "watch this video".
 *
 * Both are thin ToolDefinitions: they resolve the model-supplied path, bind it
 * to the validated canonical inode, and hand that path to an engine module
 * (transcribe-media.ts / video-frames.ts) that never sees an unvalidated path
 * — the same split ocr-tool.ts uses.
 */

import { existsSync, closeSync } from "node:fs";
import type { ToolDefinition } from "../types.js";
import { openValidatedRead } from "../security/layer/index.js";
import { wrapExternalContent } from "../sanitize.js";
import { resolveMediaPath } from "./shared/media-path.js";
import { TRANSCRIBABLE_EXTS, VIDEO_EXTS } from "./shared/media-formats.js";

/** Bind a model-supplied media path to the validated canonical inode, so the
 *  bytes ffmpeg opens are the bytes the file-access gate approved and a
 *  symlink swapped in afterwards (R4-19) is rejected here. */
function openMediaPath(raw: string, allowed: ReadonlySet<string>, kind: string):
  { canonicalPath: string } | { error: string } {
  const filePath = resolveMediaPath(raw);
  if (!existsSync(filePath)) return { error: `File not found: ${filePath}` };
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (!allowed.has(ext)) {
    return { error: `Not a ${kind} file: .${ext}. Supported: ${[...allowed].sort().join(", ")}.` };
  }
  try {
    const { fd, canonicalPath } = openValidatedRead(filePath);
    closeSync(fd);
    return { canonicalPath };
  } catch (e) {
    return { error: `Cannot read ${filePath}: ${(e as Error).message}` };
  }
}

export const transcribeMediaTool: ToolDefinition = {
  name: "transcribe_media",
  description:
    "Transcribe the speech in a local audio OR video file into timestamped text. " +
    "Use this whenever the user asks what was said in a recording, meeting, voice note, podcast, or video — " +
    "including a video, where this reads the audio track (pair it with read_video_frames to also SEE the video). " +
    "Supports mp3, m4a, wav, ogg, opus, flac, aac, and every video container. " +
    "Long recordings return the first 30 minutes; call again with start_at to continue.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the audio or video file (absolute, relative, or a bare filename from ~/.lax/uploads)" },
      start_at: { type: "number", description: "Second to start transcribing from (default 0). Use the end_at from a previous call to continue a long recording." },
    },
    required: ["path"],
  },
  async execute(args) {
    const opened = openMediaPath(String(args.path || ""), TRANSCRIBABLE_EXTS, "audio or video");
    if ("error" in opened) return { content: opened.error, isError: true };

    try {
      const { transcribeMediaFile, formatTranscript } = await import("./transcribe-media.js");
      const result = await transcribeMediaFile(opened.canonicalPath, {
        startSec: args.start_at != null ? Number(args.start_at) : 0,
      });

      if (result.windows.length === 0) {
        return { content: `No speech detected in ${opened.canonicalPath} between ${result.startSec}s and ${result.endSec}s.` };
      }

      const header = result.durationSec > 0
        ? `Transcript of ${opened.canonicalPath} (${result.durationSec.toFixed(0)}s total), covering ${result.startSec}s-${result.endSec.toFixed(0)}s`
        : `Transcript of ${opened.canonicalPath}, covering ${result.startSec}s-${result.endSec.toFixed(0)}s`;
      const more = result.hasMore
        ? `\n\nThis file continues past ${result.endSec.toFixed(0)}s — call transcribe_media again with start_at=${Math.floor(result.endSec)} for the rest.`
        : "";

      // A transcript is text the FILE supplied, not the user — wrap it so a
      // recording that reads out instructions is quoted, not obeyed.
      return {
        content: `${header}:\n\n${wrapExternalContent(formatTranscript(result), "transcribe_media", { file: opened.canonicalPath })}${more}`,
      };
    } catch (e) {
      return { content: `Transcription failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export const readVideoFramesTool: ToolDefinition = {
  name: "read_video_frames",
  description:
    "SEE a local video by sampling still frames from it, evenly spaced across its length, and viewing them. " +
    "Use this when the user asks you to watch, look at, review, or describe what happens in a video file. " +
    "This gives you the PICTURE only — call transcribe_media on the same file for what is said. " +
    "Supports mp4, mov, webm, mkv, avi, m4v.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the video file (absolute, relative, or a bare filename from ~/.lax/uploads)" },
      frames: { type: "number", description: "How many frames to sample, 1-12 (default 6). Use more for a long or fast-moving video." },
      question: { type: "string", description: "What to look for in the video (default: describe what happens)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const opened = openMediaPath(String(args.path || ""), VIDEO_EXTS, "video");
    if ("error" in opened) return { content: opened.error, isError: true };

    try {
      const { sampleVideoFrames, DEFAULT_FRAMES } = await import("./video-frames.js");
      const sample = await sampleVideoFrames(
        opened.canonicalPath,
        args.frames != null ? Number(args.frames) : DEFAULT_FRAMES,
      );
      const question = String(args.question || "Describe what happens in this video.");
      const lengthNote = sample.durationSec > 0 ? ` (${sample.durationSec.toFixed(1)}s)` : "";
      const stamps = sample.frames.map(f => `${f.atSec.toFixed(1)}s`).join(", ");

      return {
        content:
          `${sample.frames.length} frame(s) sampled from ${opened.canonicalPath}${lengthNote} at ${stamps}, ` +
          `shown to you below in order.\nQuestion: ${question}`,
        _images: sample.frames.map(f => ({
          mime: "image/jpeg",
          b64: f.jpeg.toString("base64"),
          path: `${opened.canonicalPath}@${f.atSec.toFixed(1)}s`,
          question,
        })),
      };
    } catch (e) {
      return { content: `Reading video frames failed: ${(e as Error).message}`, isError: true };
    }
  },
};
