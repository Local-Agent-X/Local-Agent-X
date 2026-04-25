// Streaming TTS model fetcher.
//
// Downloads + extracts the Matcha-icefall LJSpeech English voice bundle and
// the matching Vocos vocoder from the k2-fsa sherpa-onnx GitHub releases.
// Cached to ~/.sax/models/tts/ and reused.
//
// Artifacts after fetch (~128MB total):
//   ~/.sax/models/tts/matcha-icefall-en_US-ljspeech/
//     model-steps-3.onnx          (~71MB, acoustic model)
//     tokens.txt                   (phoneme vocabulary)
//     espeak-ng-data/              (directory, ~25MB, phoneme rules per lang)
//     vocos-22khz-univ.onnx        (~51MB, separate vocoder release)
//
// The matcha bundle ships as tar.bz2; we extract with system `tar -xjf`
// which is available on Windows 10+ (bundled bsdtar), macOS, and Linux.
// The vocoder is a loose .onnx — no extraction needed.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const MODEL_DIR = join(homedir(), ".lax", "models", "tts");
const BUNDLE_NAME = "matcha-icefall-en_US-ljspeech";
const BUNDLE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${BUNDLE_NAME}.tar.bz2`;
const VOCODER_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx";
const VOCODER_NAME = "vocos-22khz-univ.onnx";

export interface TTSModelPaths {
  acousticModel: string;
  vocoder: string;
  tokens: string;
  dataDir: string;
  modelDir: string;
  sampleRate: number;
}

export function getTTSModelPaths(): TTSModelPaths {
  const dir = join(MODEL_DIR, BUNDLE_NAME);
  return {
    modelDir: dir,
    acousticModel: join(dir, "model-steps-3.onnx"),
    vocoder: join(dir, VOCODER_NAME),
    tokens: join(dir, "tokens.txt"),
    dataDir: join(dir, "espeak-ng-data"),
    sampleRate: 22050,
  };
}

export function ttsModelExists(): boolean {
  const p = getTTSModelPaths();
  try {
    if (!existsSync(p.acousticModel) || !existsSync(p.vocoder) || !existsSync(p.tokens) || !existsSync(p.dataDir)) return false;
    if (statSync(p.acousticModel).size < 10_000_000) return false;
    if (statSync(p.vocoder).size < 10_000_000) return false;
    // espeak-ng-data should have several files
    if (readdirSync(p.dataDir).length < 5) return false;
    return true;
  } catch { return false; }
}

export interface TTSFetchProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesDownloaded: number;
  bytesTotal: number;
  overallPct: number;
}

export async function ensureTTSModelDownloaded(
  onProgress?: (p: TTSFetchProgress) => void,
  signal?: AbortSignal,
): Promise<TTSModelPaths> {
  if (ttsModelExists()) return getTTSModelPaths();

  const paths = getTTSModelPaths();
  mkdirSync(MODEL_DIR, { recursive: true });
  mkdirSync(paths.modelDir, { recursive: true });

  const bundlePath = join(MODEL_DIR, `${BUNDLE_NAME}.tar.bz2`);
  const vocoderPath = paths.vocoder;

  // Probe sizes for a combined progress bar
  let bundleTotal = 75_000_000;
  let vocoderTotal = 55_000_000;
  try {
    const r1 = await fetch(BUNDLE_URL, { method: "HEAD", redirect: "follow", signal });
    const v1 = parseInt(r1.headers.get("content-length") || "0", 10);
    if (v1 > 0) bundleTotal = v1;
  } catch {}
  try {
    const r2 = await fetch(VOCODER_URL, { method: "HEAD", redirect: "follow", signal });
    const v2 = parseInt(r2.headers.get("content-length") || "0", 10);
    if (v2 > 0) vocoderTotal = v2;
  } catch {}
  const overallTotal = bundleTotal + vocoderTotal;

  let overallSoFar = 0;

  // 1. Download the tar.bz2 bundle
  try {
    await downloadOne(BUNDLE_URL, bundlePath, `${BUNDLE_NAME}.tar.bz2`, 0, 2, overallSoFar, overallTotal, onProgress, signal);
    overallSoFar += statSync(bundlePath).size;
  } catch (e) {
    try { unlinkSync(bundlePath); } catch {}
    throw new Error(`TTS bundle download failed: ${(e as Error).message}`);
  }

  // 2. Extract with system tar (GNU on *nix/git-bash, bsdtar on native Windows 10+)
  try {
    await extractTarBz2(bundlePath, MODEL_DIR);
  } catch (e) {
    try { unlinkSync(bundlePath); } catch {}
    throw new Error(`TTS bundle extraction failed: ${(e as Error).message}`);
  }
  try { unlinkSync(bundlePath); } catch {}

  // 3. Download vocoder (loose onnx, parallel-ish)
  try {
    await downloadOne(VOCODER_URL, vocoderPath, VOCODER_NAME, 1, 2, overallSoFar, overallTotal, onProgress, signal);
  } catch (e) {
    try { unlinkSync(vocoderPath); } catch {}
    throw new Error(`TTS vocoder download failed: ${(e as Error).message}`);
  }

  if (!ttsModelExists()) {
    throw new Error("TTS model setup completed but expected files are missing — archive layout may have changed");
  }
  return paths;
}

async function downloadOne(
  url: string,
  outPath: string,
  displayName: string,
  idx: number,
  total: number,
  overallSoFar: number,
  overallTotal: number,
  onProgress: ((p: TTSFetchProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  if (!res.body) throw new Error(`No body from ${url}`);

  const fileLen = parseInt(res.headers.get("content-length") || "0", 10);
  let written = 0;
  const sink = createWriteStream(outPath);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise<void>((resolve, reject) => sink.write(value, (err) => err ? reject(err) : resolve()));
    written += value.byteLength;
    if (onProgress) {
      const overallPct = overallTotal > 0 ? ((overallSoFar + written) / overallTotal) * 100 : 0;
      onProgress({
        file: displayName,
        fileIndex: idx,
        fileCount: total,
        bytesDownloaded: written,
        bytesTotal: fileLen > 0 ? fileLen : written,
        overallPct: Math.min(100, overallPct),
      });
    }
  }
  await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => err ? reject(err) : resolve()));

  // Catch silent truncation. The Windows TCP stack has historically
  // surfaced partial streams without error events on the ReadableStream;
  // cross-checking bytes against content-length is our safety net.
  if (fileLen > 0 && written < fileLen) {
    throw new Error(`truncated download — got ${written} of ${fileLen} bytes`);
  }
}

function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Two Windows quirks to work around:
    //   1. GNU tar parses `C:\foo` as `host:path` (rcmd style) and tries to
    //      ssh to host "C". `--force-local` disables that heuristic.
    //   2. Even with --force-local, passing absolute Windows paths can
    //      confuse path normalization. We cwd into destDir and pass just
    //      the archive basename, so tar never sees a drive letter.
    const path = archivePath.replace(/\\/g, "/");
    const basename = path.substring(path.lastIndexOf("/") + 1);
    const child = spawn("tar", ["--force-local", "-xjf", basename], {
      cwd: destDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => reject(new Error(`spawn tar failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

// Exposed for explicit "wipe and re-download" flows (not used by default)
export function purgeTTSModel(): void {
  const p = getTTSModelPaths();
  try { rmSync(p.modelDir, { recursive: true, force: true }); } catch {}
}
