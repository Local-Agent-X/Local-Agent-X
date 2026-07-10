/**
 * Canonical ffmpeg binary resolution — the single chokepoint every ffmpeg
 * consumer (screenshots, screen-stream, voice codecs, camera, video summary)
 * resolves through, mirroring ripgrepBin() in tools/grep-tool.ts.
 *
 * Order, by how deliberately each source was chosen:
 *   1. LAX_FFMPEG — explicit operator override, always wins;
 *   2. the copy baked into the packaged app (LAX_BUNDLED_BIN_DIR, set by the
 *      Electron main) — a fresh Windows/macOS box has no ffmpeg, and a
 *      Finder-launched app's minimal launchd PATH wouldn't find one anyway;
 *   3. ffmpeg-static in node_modules — reaches OTA users, dev, source installs;
 *   4. bare `ffmpeg` on PATH, the historical behavior.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

// ffmpeg-static's index.js exports the binary path, but importing it executes
// package code; resolving the module URL and joining to the sibling binary
// (it lives next to index.js) keeps this side-effect-free, same as the
// @vscode/ripgrep resolution in grep-tool.
let cachedNodeModulesFfmpeg: string | null | undefined;
function nodeModulesFfmpeg(): string | null {
  if (cachedNodeModulesFfmpeg !== undefined) return cachedNodeModulesFfmpeg;
  try {
    const pkgDir = dirname(fileURLToPath(import.meta.resolve("ffmpeg-static")));
    const p = join(pkgDir, exe);
    cachedNodeModulesFfmpeg = existsSync(p) ? p : null;
  } catch {
    cachedNodeModulesFfmpeg = null;
  }
  return cachedNodeModulesFfmpeg;
}

export function ffmpegBin(): string {
  if (process.env.LAX_FFMPEG) return process.env.LAX_FFMPEG;
  const bundled = process.env.LAX_BUNDLED_BIN_DIR;
  if (bundled) {
    const p = join(bundled, exe);
    if (existsSync(p)) return p;
  }
  return nodeModulesFfmpeg() ?? "ffmpeg";
}
