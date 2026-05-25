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

async function fetchOne(file) {
  const dest = join(outDir, file.name);
  if (isPresent(dest, file.minBytes)) {
    console.log(`[whisper-bundle] ${file.name} already present — skipping`);
    return;
  }
  const tmp = `${dest}.partial`;
  console.log(`[whisper-bundle] fetching ${file.name}`);
  const res = await fetch(`${base}/${file.name}`, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`fetch ${file.name} failed: HTTP ${res.status}`);
  }
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmp);
    Readable.fromWeb(res.body).pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  await rename(tmp, dest);
  const got = statSync(dest).size;
  if (got < file.minBytes) {
    await unlink(dest);
    throw new Error(`${file.name} too small (${got} < ${file.minBytes} bytes)`);
  }
}

mkdirSync(outDir, { recursive: true });
for (const f of files) {
  await fetchOne(f);
}
console.log(`[whisper-bundle] tiny.en ready in ${outDir}`);
