/**
 * macOS screenshot capture via the OS-native `screencapture` CLI.
 *
 * Deliberately NOT ffmpeg/avfoundation: the single-frame path has no need for
 * the streaming pipeline's device-index discovery (screen-stream/ffmpeg-capture
 * avfScreenIndex) or pixel-format pinning, and `screencapture` is present on
 * every macOS install, honors Retina resolution, and is what the OS itself
 * gates behind the Screen Recording TCC permission. Scaling and JPEG
 * conversion go through `sips`, equally built-in.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ScreenCaptureOptions, ScreenCaptureResult } from "./screen-capture.js";

const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";

/** Build the `screencapture` argv. Pure + exported for tests.
 *  `-x` mutes the shutter sound; `-D` is 1-based display number; `-R` is a
 *  capture rect in points (for the primary display this matches the tool
 *  API's "region relative to the chosen monitor" contract; secondary-display
 *  region math needs real bounds enumeration — multi-monitor macOS regions
 *  are primary-only for now, same limitation as screen-stream). */
export function buildScreencaptureArgs(
  outFile: string,
  options: Pick<ScreenCaptureOptions, "monitor" | "region">,
): string[] {
  const args = ["-x", "-t", "png"];
  if (options.monitor != null) args.push("-D", String(Math.trunc(options.monitor) + 1));
  if (options.region) {
    const { x, y, width, height } = options.region;
    args.push("-R", `${x},${y},${width},${height}`);
  }
  args.push(outFile);
  return args;
}

/** Build the `sips` argv converting/scaling the captured PNG in place-to-out.
 *  Returns null when no transform is needed (png at full scale). Pure +
 *  exported for tests. */
export function buildSipsArgs(
  inFile: string,
  outFile: string,
  format: "png" | "jpg",
  quality: number,
  targetWidth: number | null,
): string[] | null {
  const args: string[] = [];
  if (format === "jpg") {
    args.push("-s", "format", "jpeg", "-s", "formatOptions", String(Math.min(100, Math.max(1, Math.round(quality)))));
  }
  if (targetWidth !== null) args.push("--resampleWidth", String(targetWidth));
  if (args.length === 0) return null;
  return [...args, inFile, "--out", outFile];
}

/** Width/height from a PNG's IHDR chunk (always the first chunk, fixed offsets). */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452 /* "IHDR" */) {
    throw new Error("Screenshot capture failed: screencapture produced no readable PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function captureScreenMacImpl(
  options: ScreenCaptureOptions,
  tmpDir: string,
): ScreenCaptureResult {
  const format = options.format ?? "png";
  const scale = Math.min(1, Math.max(0.1, Number(options.scale ?? 1.0) || 1.0));
  const stamp = randomBytes(6).toString("hex");
  const rawFile = join(tmpDir, `shot_${stamp}.png`);
  const outFile = join(tmpDir, `shot_${stamp}_out.${format === "jpg" ? "jpg" : "png"}`);

  try {
    try {
      execFileSync(SCREENCAPTURE, buildScreencaptureArgs(rawFile, options), { timeout: 15_000 });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const reason = (err.stderr ? err.stderr.toString().trim() : "") || err.message || "unknown failure";
      throw new Error(
        `Screenshot capture failed: ${reason.split("\n")[0]}. ` +
        "If the image is missing or black, grant Screen Recording to Local Agent X in " +
        "System Settings → Privacy & Security → Screen Recording, then retry.",
      );
    }

    const raw = readFileSync(rawFile);
    const dims = pngDimensions(raw);
    const outW = Math.max(1, Math.round(dims.width * scale));
    const outH = Math.max(1, Math.round(dims.height * scale));

    const sipsArgs = buildSipsArgs(rawFile, outFile, format, options.quality ?? 85, scale < 1 ? outW : null);
    const image = sipsArgs === null ? raw : (execFileSync(SIPS, sipsArgs, { timeout: 15_000 }), readFileSync(outFile));

    return { image, format, width: outW, height: outH, capturedAt: new Date().toISOString() };
  } finally {
    for (const f of [rawFile, outFile]) {
      try { unlinkSync(f); } catch { /* not created */ }
    }
  }
}
