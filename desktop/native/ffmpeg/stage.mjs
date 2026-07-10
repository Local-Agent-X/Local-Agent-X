#!/usr/bin/env node
// Stage the ffmpeg + ffprobe binaries into desktop/native/dist-bin/ so
// electron-builder bakes them into the .app/.exe next to rg and the speech
// helper. Screenshots (gdigrab), screen-stream, camera, video summary, and
// the voice codecs all shell out to them, which a fresh Windows/macOS box
// simply doesn't have — and a Finder-launched app's minimal launchd PATH
// wouldn't find them anyway. The server resolves by absolute path
// (LAX_BUNDLED_BIN_DIR) via ffmpegBin()/ffprobeBin(). The binaries come from
// ffmpeg-static and @ffprobe-installer; this just copies their resolved paths.
//
// .gitignored — CI re-stages on each packaging step. Non-fatal by default so a
// dev build without the binaries still runs (the resolvers fall back to
// node_modules / PATH); FFMPEG_STAGE_STRICT=1 fails the build so a packaged
// installer never silently ships without them.

import { copyFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist-bin");
const ext = process.platform === "win32" ? ".exe" : "";
const STRICT = process.env.FFMPEG_STAGE_STRICT === "1";

async function stage(name, resolveSrc) {
  try {
    const src = await resolveSrc();
    if (!src) throw new Error(`no binary resolved for this platform`);
    await mkdir(outDir, { recursive: true });
    const dest = join(outDir, name + ext);
    await copyFile(src, dest);
    if (process.platform !== "win32") await chmod(dest, 0o755);
    console.log(`[ffmpeg-bundle] staged ${src} → ${dest}`);
  } catch (err) {
    const msg = `[ffmpeg-bundle] could not stage ${name}: ${err.message}`;
    if (STRICT) {
      console.error(`${msg} — FFMPEG_STAGE_STRICT=1, failing build.`);
      process.exit(1);
    }
    console.warn(`${msg} — the resolver will fall back to node_modules / PATH. Continuing.`);
  }
}

await stage("ffmpeg", async () => (await import("ffmpeg-static")).default);
await stage("ffprobe", async () => (await import("@ffprobe-installer/ffprobe")).default.path);
