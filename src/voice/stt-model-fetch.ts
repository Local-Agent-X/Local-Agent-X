// Streaming ASR model fetcher.
//
// Sherpa-ONNX needs a set of ONNX files (encoder/decoder/joiner) + tokens to
// run streaming transducer inference. The ~50MB bundle is downloaded on first
// use to ~/.lax/models/stt/ and reused. Progress is reported via an
// optional onProgress callback so the UI can render "downloading STT model"
// states instead of a cold silence.
//
// Model choice: Zipformer2 English streaming (~50MB quantized int8). Works
// on CPU, low latency, good accuracy for a personal assistant. Switch by
// changing MODEL_ID below — other options live at huggingface.co/csukuangfj.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

const MODEL_DIR = join(getLaxDir(), "models", "stt");

// Zipformer2 streaming English, int8 quantized (~70MB total). Released by
// k2-fsa; Apache-2.0 code + CC0 tokens. The 2023-02-17 "20M" model we
// previously used is zipformer1 format and is incompatible with newer
// sherpa-onnx runtimes that expect zipformer2 metadata keys like
// query_head_dims.
const MODEL_ID = "sherpa-onnx-streaming-zipformer-en-2023-06-26";
const MODEL_BASE = `https://huggingface.co/csukuangfj/${MODEL_ID}/resolve/main`;

interface ModelFile {
  name: string;
  url: string;
  minBytes: number; // sanity-check minimum size to detect truncated downloads
}

// Actual sizes at rest for the 2023-06-26 streaming zipformer2 model:
//   encoder int8  ~71MB, decoder ~2MB, joiner int8 ~260KB, tokens ~5KB
// Sanity-check thresholds are set to reject clearly-truncated files only.
// A truly corrupt ONNX file will also fail at sherpa-onnx load time.
const MODEL_FILES: ModelFile[] = [
  { name: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx", url: `${MODEL_BASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, minBytes: 1_000_000 },
  { name: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx", url: `${MODEL_BASE}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`, minBytes: 100_000 },
  { name: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx", url: `${MODEL_BASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, minBytes: 10_000 },
  { name: "tokens.txt", url: `${MODEL_BASE}/tokens.txt`, minBytes: 500 },
];

export interface ModelPaths {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  modelDir: string;
}

export function getModelPaths(): ModelPaths {
  const dir = join(MODEL_DIR, MODEL_ID);
  return {
    modelDir: dir,
    encoder: join(dir, "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"),
    decoder: join(dir, "decoder-epoch-99-avg-1-chunk-16-left-128.onnx"),
    joiner: join(dir, "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"),
    tokens: join(dir, "tokens.txt"),
  };
}

export function modelExists(): boolean {
  const p = getModelPaths();
  if (!existsSync(p.encoder) || !existsSync(p.decoder) || !existsSync(p.joiner) || !existsSync(p.tokens)) return false;
  // Size sanity — an interrupted download can leave a truncated file
  for (const f of MODEL_FILES) {
    const full = join(p.modelDir, f.name);
    try {
      if (statSync(full).size < f.minBytes) return false;
    } catch { return false; }
  }
  return true;
}

export interface FetchProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesDownloaded: number;
  bytesTotal: number;
  overallPct: number;
}

/**
 * Download all model files if not already present. Idempotent — if every
 * file exists at the expected min-size, returns immediately without touching
 * the network. On partial failure, cleans up the half-written file before
 * throwing so the next call retries from scratch.
 */
export async function ensureModelDownloaded(
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<ModelPaths> {
  if (modelExists()) return getModelPaths();

  const paths = getModelPaths();
  mkdirSync(paths.modelDir, { recursive: true });

  let overallDownloaded = 0;
  let overallTotal = 0;

  // First pass: HEAD every file to get total bytes for the progress bar
  for (const f of MODEL_FILES) {
    try {
      const res = await fetch(f.url, { method: "HEAD", signal });
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      if (len > 0) overallTotal += len;
      else overallTotal += f.minBytes * 2; // rough estimate if server doesn't expose size
    } catch {
      overallTotal += f.minBytes * 2;
    }
  }

  for (let i = 0; i < MODEL_FILES.length; i++) {
    const f = MODEL_FILES[i];
    const outPath = join(paths.modelDir, f.name);
    try {
      await downloadOne(f, outPath, i, MODEL_FILES.length, overallDownloaded, overallTotal, onProgress, signal);
      overallDownloaded += statSync(outPath).size;
    } catch (e) {
      // Remove partial file so the next attempt starts clean
      try { unlinkSync(outPath); } catch {}
      throw new Error(`STT model download failed for ${f.name}: ${(e as Error).message}`);
    }
  }

  if (!modelExists()) {
    throw new Error("STT model download completed but sanity-check failed — files may be truncated");
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
  onProgress: ((p: FetchProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const res = await fetch(file.url, { signal });
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
        fileIndex: idx,
        fileCount: total,
        bytesDownloaded: written,
        bytesTotal,
        overallPct: Math.min(100, overallPct),
      });
    }
  }
  await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => err ? reject(err) : resolve()));
}
