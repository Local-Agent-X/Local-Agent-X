// Local cache shim for tier 4 models.
//
// kokoro-js fetches weights from HuggingFace on first call. That works once,
// but we want the same offline-after-first-run contract that the rest of the
// voice stack has — store under ~/.lax/models/tts/kokoro-onnx/ and pin the
// HF cache to that directory.
//
// We don't run the download ourselves; we let @huggingface/transformers do it
// and just configure its cache root. That avoids re-implementing the HF cache
// layout (snapshots/, blobs/, refs/) by hand.
//
// For Chatterbox cloning, this also exposes a placeholder loader for a
// reference WAV → 24kHz float32 mono buffer that the speech_encoder graph
// would consume. The actual encoder run is in chatterbox-clone-stub.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIER4_CACHE = join(homedir(), ".lax", "models", "tts", "kokoro-onnx");

export function getTier4CacheDir(): string {
  if (!existsSync(TIER4_CACHE)) mkdirSync(TIER4_CACHE, { recursive: true });
  return TIER4_CACHE;
}

export function configureHFCache(): void {
  // @huggingface/transformers reads HF_HOME / TRANSFORMERS_CACHE on import.
  // Set both before requiring kokoro-js so the model lands in our directory.
  const dir = getTier4CacheDir();
  process.env.HF_HOME = dir;
  process.env.TRANSFORMERS_CACHE = dir;
  process.env.HUGGINGFACE_HUB_CACHE = dir;
}

export interface Tier4ModelStatus {
  cached: boolean;
  cacheDir: string;
  approxBytes: number;
}

export function tier4ModelStatus(modelId: string): Tier4ModelStatus {
  // HF cache layout: <cache>/models--<owner>--<name>/snapshots/<sha>/
  const dir = getTier4CacheDir();
  const slug = modelId.replace(/\//g, "--");
  const repoDir = join(dir, `models--${slug}`);
  if (!existsSync(repoDir)) {
    return { cached: false, cacheDir: dir, approxBytes: 0 };
  }
  let total = 0;
  try {
    const blobsDir = join(repoDir, "blobs");
    if (existsSync(blobsDir)) {
      for (const f of readdirSync(blobsDir)) {
        try { total += statSync(join(blobsDir, f)).size; } catch {}
      }
    }
  } catch {}
  return { cached: total > 1_000_000, cacheDir: dir, approxBytes: total };
}

// Reference-WAV loader for future Chatterbox cloning. Reads a 16-bit PCM WAV
// from disk and returns a 24 kHz float32 mono buffer. We don't resample here
// — caller must ensure the file is 24 kHz mono — so the helper stays small.
//
// Right now this is consumed only by chatterbox-clone-stub.ts; Kokoro doesn't
// need a reference audio.
export function loadReferenceWav24kMono(path: string): Float32Array {
  const buf = readFileSync(path);
  const headerLen = 44;
  if (buf.length <= headerLen) {
    throw new Error(`reference WAV too short: ${path}`);
  }
  const sampleCount = (buf.length - headerLen) / 2;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const lo = buf[headerLen + i * 2];
    const hi = buf[headerLen + i * 2 + 1];
    let s = (hi << 8) | lo;
    if (s & 0x8000) s -= 0x10000;
    out[i] = s / 0x8000;
  }
  return out;
}
