// Whisper model fetcher (offline post-correction pass).
//
// Three Whisper variants are supported. Picked per-session in this order:
//   1. explicit { variant } argument
//   2. LAX_VOICE_WHISPER_MODEL env var (lowercased + validated)
//   3. settings.json `voiceWhisperModel` (resolved by voice-session, then
//      passed in as an option)
//   4. DEFAULT_WHISPER_VARIANT (tiny.en) — speed wins for dictation. The
//      streaming WS dictate path runs Whisper once per utterance after
//      VAD speech-end; small.en added ~1s of perceived lag vs real-browser
//      Web Speech. tiny.en's 7-10% WER is plenty for dictation review-
//      then-send. Power users who want max accuracy bump to base/small
//      from the settings dropdown.
//
//   tiny.en   ~104MB   ~7-10% WER   ~150-300ms / utterance   (default)
//   base.en   ~150MB   ~5-7% WER    ~300-600ms / utterance
//   small.en  ~280MB   ~3-5% WER    ~700-1500ms / utterance
//
// Files live at ~/.lax/models/whisper-<variant-with-dot->dash>/ and are
// pulled from csukuangfj/sherpa-onnx-whisper-<variant> on first use.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type WhisperVariant = "tiny.en" | "base.en" | "small.en";

export const VALID_WHISPER_VARIANTS: ReadonlySet<WhisperVariant> =
  new Set<WhisperVariant>(["tiny.en", "base.en", "small.en"]);

export const DEFAULT_WHISPER_VARIANT: WhisperVariant = "tiny.en";

export function resolveWhisperVariant(opts?: { variant?: WhisperVariant }): WhisperVariant {
  if (opts?.variant && VALID_WHISPER_VARIANTS.has(opts.variant)) return opts.variant;
  const envRaw = process.env.LAX_VOICE_WHISPER_MODEL?.toLowerCase().trim();
  if (envRaw && VALID_WHISPER_VARIANTS.has(envRaw as WhisperVariant)) {
    return envRaw as WhisperVariant;
  }
  return DEFAULT_WHISPER_VARIANT;
}

interface ModelFile { name: string; url: string; minBytes: number; }

interface VariantSpec { encoder: number; decoder: number; tokens: number; }

// Conservative truncation guards — ~60% of real int8 size. sherpa-onnx
// re-verifies ONNX integrity on load so these only catch obviously
// truncated downloads.
const VARIANT_SPECS: Record<WhisperVariant, VariantSpec> = {
  "tiny.en":  { encoder:  8_000_000, decoder:  50_000_000, tokens: 100_000 },
  "base.en":  { encoder: 14_000_000, decoder:  55_000_000, tokens: 100_000 },
  "small.en": { encoder: 50_000_000, decoder: 180_000_000, tokens: 100_000 },
};

function modelDirFor(variant: WhisperVariant): string {
  return join(homedir(), ".lax", "models", `whisper-${variant.replace(".", "-")}`);
}

function modelFilesFor(variant: WhisperVariant): ModelFile[] {
  const base = `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${variant}/resolve/main`;
  const spec = VARIANT_SPECS[variant];
  return [
    { name: `${variant}-encoder.int8.onnx`, url: `${base}/${variant}-encoder.int8.onnx`, minBytes: spec.encoder },
    { name: `${variant}-decoder.int8.onnx`, url: `${base}/${variant}-decoder.int8.onnx`, minBytes: spec.decoder },
    { name: `${variant}-tokens.txt`,        url: `${base}/${variant}-tokens.txt`,        minBytes: spec.tokens  },
  ];
}

export interface WhisperModelPaths {
  encoder: string;
  decoder: string;
  tokens: string;
  modelDir: string;
  variant: WhisperVariant;
}

export function getWhisperModelPaths(opts?: { variant?: WhisperVariant }): WhisperModelPaths {
  const variant = resolveWhisperVariant(opts);
  const modelDir = modelDirFor(variant);
  return {
    variant,
    modelDir,
    encoder: join(modelDir, `${variant}-encoder.int8.onnx`),
    decoder: join(modelDir, `${variant}-decoder.int8.onnx`),
    tokens:  join(modelDir, `${variant}-tokens.txt`),
  };
}

export function whisperModelExists(opts?: { variant?: WhisperVariant }): boolean {
  const variant = resolveWhisperVariant(opts);
  const p = getWhisperModelPaths({ variant });
  const files = modelFilesFor(variant);
  try {
    for (const f of files) {
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
  opts?: { variant?: WhisperVariant },
): Promise<WhisperModelPaths> {
  const variant = resolveWhisperVariant(opts);
  if (whisperModelExists({ variant })) return getWhisperModelPaths({ variant });

  const paths = getWhisperModelPaths({ variant });
  const files = modelFilesFor(variant);
  mkdirSync(paths.modelDir, { recursive: true });

  let overallTotal = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.url, { method: "HEAD", redirect: "follow", signal });
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      overallTotal += len > 0 ? len : f.minBytes * 2;
    } catch { overallTotal += f.minBytes * 2; }
  }

  let overallSoFar = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const outPath = join(paths.modelDir, f.name);
    try {
      await downloadOne(f, outPath, i, files.length, overallSoFar, overallTotal, onProgress, signal);
      overallSoFar += statSync(outPath).size;
    } catch (e) {
      try { unlinkSync(outPath); } catch {}
      throw new Error(`Whisper model download failed for ${f.name}: ${(e as Error).message}`);
    }
  }

  if (!whisperModelExists({ variant })) {
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
