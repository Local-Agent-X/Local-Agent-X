/**
 * Canonical ffmpeg/ffprobe binary resolution — the single chokepoint every
 * consumer (screenshots, screen-stream, voice codecs, camera, video summary)
 * resolves through, mirroring ripgrepBin() in tools/grep-tool.ts.
 *
 * Order, by how deliberately each source was chosen:
 *   1. LAX_FFMPEG / LAX_FFPROBE — explicit operator override, always wins;
 *   2. the copy baked into the packaged app (LAX_BUNDLED_BIN_DIR, set by the
 *      Electron main) — a fresh Windows/macOS box has neither binary, and a
 *      Finder-launched app's minimal launchd PATH wouldn't find one anyway;
 *   3. node_modules (ffmpeg-static / @ffprobe-installer) — reaches OTA users,
 *      dev, source installs;
 *   4. the bare name on PATH, the historical behavior.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const winExt = process.platform === "win32" ? ".exe" : "";

// Both packages' index.js export the binary path, but importing them executes
// package code; resolving a module URL and joining to the binary keeps this
// side-effect-free, same as the @vscode/ripgrep resolution in grep-tool.
// ffmpeg-static keeps the binary next to its index.js; @ffprobe-installer
// ships it at the root of a per-platform package.
const nodeModulesCache = new Map<string, string | null>();
function nodeModulesBin(specifier: string, binRelPath: string): string | null {
  const cached = nodeModulesCache.get(specifier);
  if (cached !== undefined) return cached;
  let p: string | null = null;
  try {
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    const candidate = join(dirname(resolved), binRelPath);
    p = existsSync(candidate) ? candidate : null;
  } catch {
    p = null;
  }
  nodeModulesCache.set(specifier, p);
  return p;
}

function resolveBin(overrideEnv: string, name: string, nodeModules: () => string | null): string {
  const override = process.env[overrideEnv];
  if (override) return override;
  const bundled = process.env.LAX_BUNDLED_BIN_DIR;
  if (bundled) {
    const p = join(bundled, name + winExt);
    if (existsSync(p)) return p;
  }
  return nodeModules() ?? name;
}

export function ffmpegBin(): string {
  return resolveBin("LAX_FFMPEG", "ffmpeg", () =>
    nodeModulesBin("ffmpeg-static", "ffmpeg" + winExt));
}

export function ffprobeBin(): string {
  return resolveBin("LAX_FFPROBE", "ffprobe", () =>
    nodeModulesBin(
      `@ffprobe-installer/${process.platform}-${process.arch}/package.json`,
      "ffprobe" + winExt,
    ));
}
