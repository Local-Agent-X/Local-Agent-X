// Whisper model fetcher (offline post-correction pass).
//
// Downloads OpenAI Whisper small.en int8 (~350MB total) on first use to
// ~/.lax/models/whisper-small-en/. Runs after VAD speech-end on the full
// buffered utterance.
//
// Model: csukuangfj/sherpa-onnx-whisper-small.en. Small.en is the
// quality-vs-speed sweet spot for CPU users — ~3% WER (vs tiny.en's
// 7-10%, vs base.en's 5-7%) at ~700-1500ms per typical utterance on a
// modern consumer CPU. Most users don't have a discrete GPU, so making
// CPU transcription as accurate as practical is the highest-impact win.
// Upgrade path from tiny.en (Apr 2026): existing tiny.en cache stays at
// ~/.lax/models/whisper-tiny-en/ and is harmless; small.en lands in its
// own folder. Users notice ~3x accuracy jump, ~3-5x slower transcription.
// To switch tiers, change WHISPER_VARIANT + minBytes in MODEL_FILES.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WHISPER_VARIANT = "small.en";
const MODEL_DIR = join(homedir(), ".lax", "models", `whisper-${WHISPER_VARIANT.replace(".", "-")}`);
const MODEL_BASE = `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${WHISPER_VARIANT}/resolve/main`;

interface ModelFile { name: string; url: string; minBytes: number; }

// Actual sizes for int8-quantized Whisper small.en:
//   encoder ~85MB, decoder ~262MB, tokens ~835KB.
// Sanity thresholds catch clearly-truncated downloads; sherpa-onnx
// re-verifies ONNX integrity on load. If you change WHISPER_VARIANT,
// recalibrate these — wrong thresholds either reject healthy downloads
// or accept truncated ones.
const MODEL_FILES: ModelFile[] = [
  { name: `${WHISPER_VARIANT}-encoder.int8.onnx`, url: `${MODEL_BASE}/${WHISPER_VARIANT}-encoder.int8.onnx`, minBytes: 60_000_000 },
  { name: `${WHISPER_VARIANT}-decoder.int8.onnx`, url: `${MODEL_BASE}/${WHISPER_VARIANT}-decoder.int8.onnx`, minBytes: 200_000_000 },
  { name: `${WHISPER_VARIANT}-tokens.txt`,        url: `${MODEL_BASE}/${WHISPER_VARIANT}-tokens.txt`,        minBytes: 100_000 },
];

export interface WhisperModelPaths {
  encoder: string;
  decoder: string;
  tokens: string;
  modelDir: string;
}

export function getWhisperModelPaths(): WhisperModelPaths {
  return {
    modelDir: MODEL_DIR,
    encoder: join(MODEL_DIR, `${WHISPER_VARIANT}-encoder.int8.onnx`),
    decoder: join(MODEL_DIR, `${WHISPER_VARIANT}-decoder.int8.onnx`),
    tokens:  join(MODEL_DIR, `${WHISPER_VARIANT}-tokens.txt`),
  };
}

export function whisperModelExists(): boolean {
  const p = getWhisperModelPaths();
  try {
    for (const f of MODEL_FILES) {
      const full = join(p.modelDir, f.name);
      if (!existsSync(full)) return false;
      if (statSync(full).size < f.minBytes) return false;
    }
    return true;
  } catch { return false; }
}

export interface WhisperFetchProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesDownloaded: number;
  bytesTotal: number;
  overallPct: number;
}

export async function ensureWhisperModelDownloaded(
  onProgress?: (p: WhisperFetchProgress) => void,
  signal?: AbortSignal,
): Promise<WhisperModelPaths> {
  if (whisperModelExists()) return getWhisperModelPaths();

  const paths = getWhisperModelPaths();
  mkdirSync(paths.modelDir, { recursive: true });

  let overallTotal = 0;
  for (const f of MODEL_FILES) {
    try {
      const res = await fetch(f.url, { method: "HEAD", redirect: "follow", signal });
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      overallTotal += len > 0 ? len : f.minBytes * 2;
    } catch { overallTotal += f.minBytes * 2; }
  }

  let overallSoFar = 0;
  for (let i = 0; i < MODEL_FILES.length; i++) {
    const f = MODEL_FILES[i];
    const outPath = join(paths.modelDir, f.name);
    try {
      await downloadOne(f, outPath, i, MODEL_FILES.length, overallSoFar, overallTotal, onProgress, signal);
      overallSoFar += statSync(outPath).size;
    } catch (e) {
      try { unlinkSync(outPath); } catch {}
      throw new Error(`Whisper model download failed for ${f.name}: ${(e as Error).message}`);
    }
  }

  if (!whisperModelExists()) {
    throw new Error("Whisper model download completed but sanity-check failed");
  }
  return paths;
}

async function downloadOne(
  file: ModelFile,
  outPath: string,
  idx: number,
  total: number,
  overallSoFar: number,
  overallTotal: number,
  onProgress: ((p: WhisperFetchProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const res = await fetch(file.url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file.url}`);
  if (!res.body) throw new Error(`No body from ${file.url}`);

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
      const bytesTotal = fileLen > 0 ? fileLen : file.minBytes * 2;
      const overallPct = overallTotal > 0 ? ((overallSoFar + written) / overallTotal) * 100 : 0;
      onProgress({
        file: file.name,
        fileIndex: idx, fileCount: total,
        bytesDownloaded: written, bytesTotal,
        overallPct: Math.min(100, overallPct),
      });
    }
  }
  await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => err ? reject(err) : resolve()));

  if (fileLen > 0 && written < fileLen) {
    throw new Error(`truncated — got ${written} of ${fileLen} bytes`);
  }
}
