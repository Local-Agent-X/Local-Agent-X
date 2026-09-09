/**
 * Outbound media delivery — send_image / send_video, the tools that hand a
 * local file to the user over their messaging bridge.
 *
 * Split from vision-tools.ts (which had reached the 400-LOC ceiling) along the
 * line that was already there: these two tools DELIVER bytes to the user,
 * while the tools left behind PERCEIVE them for the model.
 */

import type { ToolDefinition } from "../types.js";
import { createLogger } from "../logger.js";
import { openValidatedRead } from "../security/layer/index.js";
import { resolveMediaPath } from "./shared/media-path.js";
import { IMAGE_EXTS, IMAGE_MIME, VIDEO_EXTS, VIDEO_MIME } from "./shared/media-formats.js";

const logger = createLogger("tools.media-send");

export const sendVideoTool: ToolDefinition = {
  name: "send_video",
  effect: { class: "non-idempotent" },
  description:
    "Send a video file from this computer to the user over the current messaging channel (WhatsApp/Telegram). " +
    "Use when the user asks you to send or share a video file with them. Only delivers on a messaging bridge — " +
    "on web chat the user is already at the computer with the file. Supports mp4, mov, webm, mkv, avi. " +
    "WhatsApp caps at 16MB, Telegram at 50MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the video file (absolute or relative)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const { existsSync, fstatSync, closeSync } = await import("node:fs");

    const filePath = resolveMediaPath(String(args.path || ""));
    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    if (!VIDEO_EXTS.has(ext)) return { content: `Not a video file: .${ext}. Supported: ${[...VIDEO_EXTS].join(", ")}.`, isError: true };

    // Bind to the VALIDATED canonical inode (realpath + O_NOFOLLOW leaf) so the
    // size check and the path forwarded to the bridge reference the inode the
    // gate approved — a symlink swapped in after the gate (R4-19) is rejected
    // here, not silently forwarded off-box. fstat the open fd (not the name) so
    // the size is read from the exact inode; emit the canonical path so the
    // bridge opens the same realpath we validated.
    let canonicalPath: string;
    let sizeMb: number;
    try {
      const opened = openValidatedRead(filePath);
      try {
        sizeMb = fstatSync(opened.fd).size / 1048576;
      } finally {
        closeSync(opened.fd);
      }
      canonicalPath = opened.canonicalPath;
    } catch (e) {
      return { content: `Failed to send ${filePath}: ${(e as Error).message}`, isError: true };
    }
    if (sizeMb > 50) return { content: `Video is ${sizeMb.toFixed(1)}MB — over the 50MB messaging limit, can't send.`, isError: true };

    logger.info(`[send_video] ${canonicalPath} (${sizeMb.toFixed(1)}MB)`);
    return {
      content: `Sending video to the user: ${canonicalPath} (${sizeMb.toFixed(1)}MB).`,
      _media: { kind: "video", path: canonicalPath, mime: VIDEO_MIME[ext] || "video/mp4" },
    };
  },
};


export const sendImageTool: ToolDefinition = {
  name: "send_image",
  effect: { class: "non-idempotent" },
  description:
    "Send an image FILE from this computer to the user over the current messaging channel (WhatsApp/Telegram) — " +
    "e.g. a screenshot you captured, or an image you generated/saved to a file. Use when the user asks you to send " +
    "or share an image with them. Only delivers on a messaging bridge — on web chat the user is already at the " +
    "computer with the file. Supports png, jpg, gif, webp, bmp. Capped at 10MB.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file (absolute or relative)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const { existsSync, fstatSync, closeSync } = await import("node:fs");

    const filePath = resolveMediaPath(String(args.path || ""));
    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, isError: true };

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    if (!IMAGE_EXTS.has(ext)) return { content: `Not an image file: .${ext}. Supported: ${[...IMAGE_EXTS].join(", ")}.`, isError: true };

    // Same validated-inode binding as send_video: fstat the open fd (not the
    // name) and forward the canonical realpath, so the size check + the path the
    // bridge re-gates and reads reference the inode the gate approved.
    let canonicalPath: string;
    let sizeMb: number;
    try {
      const opened = openValidatedRead(filePath);
      try {
        sizeMb = fstatSync(opened.fd).size / 1048576;
      } finally {
        closeSync(opened.fd);
      }
      canonicalPath = opened.canonicalPath;
    } catch (e) {
      return { content: `Failed to send ${filePath}: ${(e as Error).message}`, isError: true };
    }
    if (sizeMb > 10) return { content: `Image is ${sizeMb.toFixed(1)}MB — over the 10MB messaging limit, can't send.`, isError: true };

    logger.info(`[send_image] ${canonicalPath} (${sizeMb.toFixed(1)}MB)`);
    return {
      content: `Sending image to the user: ${canonicalPath} (${sizeMb.toFixed(1)}MB).`,
      _media: { kind: "image", path: canonicalPath, mime: IMAGE_MIME[ext] || "image/png" },
    };
  },
};
