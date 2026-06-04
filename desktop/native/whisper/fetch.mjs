#!/usr/bin/env node
// Pull the tiny.en Whisper ONNX files into desktop/native/dist-bin/whisper-tiny-en/
// so electron-builder can bundle them with the .app/.exe.
//
// Cross-platform (node, no shell dependencies). Runs as part of
// `npm run build:native`. The downloaded files are .gitignored — CI
// re-fetches on each packaging step. End users never see this download
// because the files are pre-bundled inside the installer.
//
// Why tiny.en only: it's the default in whisper-model-fetch.ts. Users who
// flip to base.en/small.en in settings still get a runtime download —
// those are ~150MB and ~280MB which we don't want to bake into every
// install of the app.

import { existsSync, mkdirSync, statSync, createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist-bin", "whisper-tiny-en");
const base = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main";

// (filename, minimum sane size for sanity check — partial downloads end
// up smaller than this and we re-fetch them.)
const files = [
  { name: "tiny.en-encoder.int8.onnx", minBytes: 8_000_000 },
  { name: "tiny.en-decoder.int8.onnx", minBytes: 50_000_000 },
  { name: "tiny.en-tokens.txt", minBytes: 100_000 },
];

function isPresent(path, minBytes) {
  try { return existsSync(path) && statSync(path).size >= minBytes; }
  catch { return false; }
}

// CI packaging (electron-builder) needs the model baked into the artifact, so
// there a failed fetch SHOULD fail the build — set WHISPER_FETCH_STRICT=1.
// Source installs run this on the end-user machine, where a flaky HuggingFace
// download must NOT abort the whole install: voice STT lazily downloads the
// model on first use (whisper-model-fetch.ts), so pre-bundling is a best-effort
// optimization here, not a hard requirement.
const STRICT = process.env.WHISPER_FETCH_STRICT === "1";
const MAX_ATTEMPTS = 3;

async function fetchOne(file) {
  const dest = join(outDir, file.name);
  if (isPresent(dest, file.minBytes)) {
    console.log(`[whisper-bundle] ${file.name} already present — skipping`);
    return true;
  }
  const tmp = `${dest}.partial`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[whisper-bundle] fetching ${file.name}${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ""}`);
      // Per-attempt timeout so a hung/stalled connection aborts and retries
      // instead of blocking the whole install indefinitely.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120_000);
      try {
        const res = await fetch(`${base}/${file.name}`, { redirect: "follow", signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        // pipeline() rejects on errors from EITHER stream — critically the
        // SOURCE: a network drop mid-download errors the read stream, which the
        // old manual .pipe() left unhandled, hard-crashing the process (exit 1)
        // and bypassing the retry/non-fatal logic below. That's what truncated
        // the encoder at 3.4MB and aborted the install. pipeline() routes that
        // error into the catch so we retry, then continue non-fatally.
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      } finally {
        clearTimeout(timer);
      }
      await rename(tmp, dest);
      const got = statSync(dest).size;
      if (got < file.minBytes) throw new Error(`too small (${got} < ${file.minBytes} bytes)`);
      return true;
    } catch (err) {
      try { await unlink(tmp); } catch { /* tmp may not exist */ }
      const last = attempt === MAX_ATTEMPTS;
      console.warn(`[whisper-bundle] ${file.name} failed: ${err.message}${last ? "" : " — retrying"}`);
      if (last) return false;
      await new Promise((r) => setTimeout(r, 1000 * attempt)); // linear backoff
    }
  }
  return false;
}

mkdirSync(outDir, { recursive: true });
let allOk = true;
for (const f of files) {
  if (!(await fetchOne(f))) allOk = false;
}

if (allOk) {
  console.log(`[whisper-bundle] tiny.en ready in ${outDir}`);
} else if (STRICT) {
  console.error("[whisper-bundle] model files missing and WHISPER_FETCH_STRICT=1 — failing build.");
  process.exit(1);
} else {
  // Non-fatal: keep the install alive. Voice STT fetches the model at runtime.
  console.warn("[whisper-bundle] could not pre-bundle the tiny.en model — voice STT will download it on first use. Continuing.");
}
