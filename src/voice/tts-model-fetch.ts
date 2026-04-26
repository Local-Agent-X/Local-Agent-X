// Streaming TTS model fetcher.
//
// Reverted to Matcha-icefall LJSpeech + Vocos vocoder after benchmarking
// Kokoro 82M against it on consumer CPU/WASM. Despite Kokoro's published
// 220ms first-byte claim (which assumes GPU), the sherpa-onnx WASM build
// (single-threaded, no SharedArrayBuffer) ran Kokoro at ~2-3x realtime —
// noticeably worse than Matcha's ~0.3-0.6x. Until a native ONNX-Runtime
// path is available or we move to a different runtime, Matcha wins.
//
// Artifacts after fetch (~127MB total):
//   ~/.lax/models/tts/matcha-icefall-en_US-ljspeech/
//     model-steps-3.onnx          (~71MB, acoustic model)
//     vocos-22khz-univ.onnx       (~51MB, neural vocoder, separate release)
//     tokens.txt                   (phoneme vocabulary)
//     espeak-ng-data/              (G2P rule data)

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

import { createLogger } from "../logger.js";
const logger = createLogger("voice.tts-model-fetch");

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

// Singleton in-flight promise. Concurrent voice sessions (or restarts that
// fire two near-simultaneous starts) used to race here — both would try to
// download to the same file, one's truncation handler would unlink the
// other's in-progress download, and extraction would fail with "no such
// file or directory". Sharing the promise serializes them.
let inFlight: Promise<TTSModelPaths> | null = null;

export function ensureTTSModelDownloaded(
  onProgress?: (p: TTSFetchProgress) => void,
  signal?: AbortSignal,
): Promise<TTSModelPaths> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await doDownload(onProgress, signal);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function doDownload(
  onProgress?: (p: TTSFetchProgress) => void,
  signal?: AbortSignal,
): Promise<TTSModelPaths> {
  if (ttsModelExists()) return getTTSModelPaths();

  const paths = getTTSModelPaths();
  mkdirSync(MODEL_DIR, { recursive: true });
  mkdirSync(paths.modelDir, { recursive: true });

  const bundlePath = join(MODEL_DIR, `${BUNDLE_NAME}.tar.bz2`);
  const vocoderPath = paths.vocoder;

  // Clear any partial leftover from a previous failed run before starting
  try { unlinkSync(bundlePath); } catch {}

  // Probe sizes for combined progress + integrity check
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

  // 1. Bundle (tar.bz2) — retry up to 3x on silent truncation
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await downloadOne(BUNDLE_URL, bundlePath, `${BUNDLE_NAME}.tar.bz2`, 0, 2, 0, overallTotal, onProgress, signal);
      const actualSize = statSync(bundlePath).size;
      if (bundleTotal > 0 && actualSize < bundleTotal) {
        throw new Error(`got ${actualSize} of ${bundleTotal} bytes (truncated)`);
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e as Error;
      try { unlinkSync(bundlePath); } catch {}
      logger.warn(`[tts-fetch] bundle attempt ${attempt}/3 failed: ${lastErr.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (lastErr) throw new Error(`TTS bundle download failed: ${lastErr.message}`);

  // 2. Extract bundle
  try {
    await extractTarBz2(bundlePath, MODEL_DIR);
  } catch (e) {
    try { unlinkSync(bundlePath); } catch {}
    throw new Error(`TTS bundle extraction failed: ${(e as Error).message}`);
  }
  try { unlinkSync(bundlePath); } catch {}

  // 3. Vocoder (loose .onnx, separate release)
  let vocoderErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await downloadOne(VOCODER_URL, vocoderPath, VOCODER_NAME, 1, 2, bundleTotal, overallTotal, onProgress, signal);
      const actualSize = statSync(vocoderPath).size;
      if (vocoderTotal > 0 && actualSize < vocoderTotal) {
        throw new Error(`got ${actualSize} of ${vocoderTotal} bytes (truncated)`);
      }
      vocoderErr = null;
      break;
    } catch (e) {
      vocoderErr = e as Error;
      try { unlinkSync(vocoderPath); } catch {}
      logger.warn(`[tts-fetch] vocoder attempt ${attempt}/3 failed: ${vocoderErr.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  if (vocoderErr) throw new Error(`TTS vocoder download failed: ${vocoderErr.message}`);

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

  if (fileLen > 0 && written < fileLen) {
    throw new Error(`truncated download — got ${written} of ${fileLen} bytes`);
  }
}

function extractTarBz2(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Two Windows quirks:
    //   1. GNU tar parses `C:\foo` as `host:path` and tries to ssh.
    //      `--force-local` disables that heuristic.
    //   2. Pass just the archive basename and cwd into destDir so tar
    //      never sees a drive letter.
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

export function purgeTTSModel(): void {
  const p = getTTSModelPaths();
  try { rmSync(p.modelDir, { recursive: true, force: true }); } catch {}
}
