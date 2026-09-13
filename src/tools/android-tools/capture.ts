/**
 * screenshot — capture the device screen and hand it to the model INLINE
 * (downscaled JPEG via `_image`), same idiom as browser/page-ops.ts's
 * screenshotAsBase64 and vision-tools.ts's screen_capture.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../../types.js";
import { resolveSerial, screenshot as adbScreenshot } from "../../android/index.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { err } from "../result-helpers.js";

const INLINE_IMAGE_SCALE = 0.6;
const INLINE_IMAGE_JPEG_QUALITY = 80;

async function encodeInlineJpeg(buffer: Buffer): Promise<{ b64: string } | { error: string }> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buffer).metadata();
    if (!meta.width) return { error: "could not read image dimensions" };
    const width = Math.max(1, Math.round(meta.width * INLINE_IMAGE_SCALE));
    const jpeg = await sharp(buffer).resize({ width }).jpeg({ quality: INLINE_IMAGE_JPEG_QUALITY }).toBuffer();
    return { b64: jpeg.toString("base64") };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function handleScreenshot(args: Record<string, unknown>): Promise<ToolResult> {
  const serial = await resolveSerial(args.device ? String(args.device) : undefined);
  const buffer = await adbScreenshot(serial);
  const dir = join(getLaxDir(), "uploads");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `android-screenshot-${Date.now()}.png`);
  writeFileSync(file, buffer);
  const header = `Screenshot captured\nDevice: ${serial}\nSize: ${buffer.length} bytes\nSaved: ${file}`;
  const inline = await encodeInlineJpeg(buffer);
  if ("error" in inline) {
    return err(`${header}\n\nInline preview unavailable (${inline.error}). Use 'view_image' on the saved path to see the screen.`);
  }
  const result: ToolResult & { _image: { mime: string; b64: string; path: string; question: string } } = {
    content: `${header}\n\nThe device screen is shown to you inline (downscaled JPEG) — no extra call needed.`,
    _image: { mime: "image/jpeg", b64: inline.b64, path: file, question: `This is the current Android screen on device ${serial}.` },
  };
  return result;
}
