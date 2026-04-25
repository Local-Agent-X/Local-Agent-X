// Silero VAD model fetcher.
//
// Downloads the single silero_vad.onnx file (~1.8MB) on first use. Used by
// vad-stream.ts to do fast voice-activity detection — primary endpoint
// signal (fires ~500ms after last speech) plus barge-in trigger when the
// user talks over the agent.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_DIR = join(homedir(), ".lax", "models", "vad");
const MODEL_NAME = "silero_vad.onnx";
const MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
// k2-fsa ships the int8-quantized Silero (~630KB, vs the stock 1.85MB
// float32 model on silero-vad GitHub). Threshold rejects clearly
// truncated downloads while accepting the quantized real file.
const MIN_BYTES = 400_000;

export interface VadModelPaths {
  model: string;
  modelDir: string;
}

export function getVadModelPaths(): VadModelPaths {
  return { modelDir: MODEL_DIR, model: join(MODEL_DIR, MODEL_NAME) };
}

export function vadModelExists(): boolean {
  const p = getVadModelPaths();
  try {
    if (!existsSync(p.model)) return false;
    return statSync(p.model).size >= MIN_BYTES;
  } catch { return false; }
}

export interface VadFetchProgress {
  overallPct: number;
  bytesDownloaded: number;
  bytesTotal: number;
}

export async function ensureVadModelDownloaded(
  onProgress?: (p: VadFetchProgress) => void,
  signal?: AbortSignal,
): Promise<VadModelPaths> {
  if (vadModelExists()) return getVadModelPaths();

  const paths = getVadModelPaths();
  mkdirSync(paths.modelDir, { recursive: true });

  try {
    const res = await fetch(MODEL_URL, { redirect: "follow", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${MODEL_URL}`);
    if (!res.body) throw new Error("No body");

    const fileLen = parseInt(res.headers.get("content-length") || "0", 10);
    let written = 0;
    const sink = createWriteStream(paths.model);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise<void>((resolve, reject) => sink.write(value, (err) => err ? reject(err) : resolve()));
      written += value.byteLength;
      if (onProgress) {
        const total = fileLen > 0 ? fileLen : MIN_BYTES * 2;
        onProgress({ bytesDownloaded: written, bytesTotal: total, overallPct: Math.min(100, (written / total) * 100) });
      }
    }
    await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => err ? reject(err) : resolve()));

    if (fileLen > 0 && written < fileLen) {
      throw new Error(`truncated — got ${written} of ${fileLen} bytes`);
    }
  } catch (e) {
    try { unlinkSync(paths.model); } catch {}
    throw new Error(`VAD model download failed: ${(e as Error).message}`);
  }

  if (!vadModelExists()) {
    throw new Error("VAD model download completed but sanity-check failed");
  }
  return paths;
}
