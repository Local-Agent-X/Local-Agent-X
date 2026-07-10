#!/usr/bin/env node
// Stage the ffmpeg binary into desktop/native/dist-bin/ so electron-builder
// bakes it into the .app/.exe next to rg and the speech helper. Screenshots
// (gdigrab), screen-stream, camera, and the voice codecs all shell out to
// ffmpeg, which a fresh Windows/macOS box simply doesn't have — and a
// Finder-launched app's minimal launchd PATH wouldn't find one anyway. The
// server resolves it by absolute path (LAX_BUNDLED_BIN_DIR) via ffmpegBin().
// The binary comes from ffmpeg-static; this just copies its resolved path.
//
// .gitignored — CI re-stages on each packaging step. Non-fatal by default so a
// dev build without the binary still runs (ffmpegBin falls back to
// node_modules ffmpeg-static / PATH); FFMPEG_STAGE_STRICT=1 fails the build so
// a packaged installer never silently ships without it.

import { copyFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist-bin");
const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const STRICT = process.env.FFMPEG_STAGE_STRICT === "1";

try {
  const { default: ffmpegPath } = await import("ffmpeg-static");
  if (!ffmpegPath) throw new Error("ffmpeg-static resolved no binary for this platform");
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, exe);
  await copyFile(ffmpegPath, dest);
  if (process.platform !== "win32") await chmod(dest, 0o755);
  console.log(`[ffmpeg-bundle] staged ${ffmpegPath} → ${dest}`);
} catch (err) {
  const msg = `[ffmpeg-bundle] could not stage ffmpeg: ${err.message}`;
  if (STRICT) {
    console.error(`${msg} — FFMPEG_STAGE_STRICT=1, failing build.`);
    process.exit(1);
  }
  console.warn(`${msg} — ffmpegBin will fall back to node_modules ffmpeg-static / PATH. Continuing.`);
}
