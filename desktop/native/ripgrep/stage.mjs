#!/usr/bin/env node
// Stage the ripgrep binary into desktop/native/dist-bin/ so electron-builder
// bakes it into the .app/.exe next to the other bundled binaries. The grep tool
// execs it by absolute path (LAX_BUNDLED_BIN_DIR) — a Finder-launched app gets a
// minimal launchd PATH where a bare `rg` isn't found, which is why grep silently
// fell to the slow Node search. The binary comes from @vscode/ripgrep (the
// per-OS package VS Code itself ships); this just copies its resolved path.
//
// .gitignored — CI re-stages on each packaging step. Non-fatal by default so a
// dev build without the binary still runs (grep falls back to `rg` on PATH /
// the Node search); RIPGREP_STAGE_STRICT=1 fails the build so a packaged
// installer never silently ships without it.

import { copyFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist-bin");
const exe = process.platform === "win32" ? "rg.exe" : "rg";
const STRICT = process.env.RIPGREP_STAGE_STRICT === "1";

try {
  const { rgPath } = await import("@vscode/ripgrep");
  await mkdir(outDir, { recursive: true });
  const dest = join(outDir, exe);
  await copyFile(rgPath, dest);
  if (process.platform !== "win32") await chmod(dest, 0o755);
  console.log(`[ripgrep-bundle] staged ${rgPath} → ${dest}`);
} catch (err) {
  const msg = `[ripgrep-bundle] could not stage ripgrep: ${err.message}`;
  if (STRICT) {
    console.error(`${msg} — RIPGREP_STAGE_STRICT=1, failing build.`);
    process.exit(1);
  }
  console.warn(`${msg} — grep will fall back to PATH rg / Node search. Continuing.`);
}
