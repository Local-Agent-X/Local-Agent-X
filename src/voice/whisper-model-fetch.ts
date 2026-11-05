// Local speech-to-text model fetcher (the offline pass that produces the
// final transcript of each utterance).
//
// Four variants: three Whisper sizes and NVIDIA's Parakeet TDT 0.6B v3, a
// transducer that sherpa-onnx loads differently (`kind`). Picked per-session
// in this order:
//   1. explicit { variant } argument
//   2. LAX_VOICE_WHISPER_MODEL env var (lowercased + validated)
//   3. settings.json `voiceWhisperModel` (resolved by voice-session, then
//      passed in as an option)
//   4. parakeet-v3 once it is fully on disk, else DEFAULT_WHISPER_VARIANT
//      (tiny.en) — the one bundled with the desktop app, so voice works with
//      no download. A fresh install's voice is the Local tier, which starts
//      the Parakeet download on its first session (model-init.ts).
//
// Measured 2026-11-04 on LibriSpeech dev-clean (73 clips, ~6.6 s each),
// sherpa-onnx WASM, one thread, Core Ultra 9 285K — words wrong (titles and
// numbers spelled out on both sides) / median time per clip / download:
//   tiny.en      10.2%   0.95 s    ~104MB (default, bundled)
//   base.en      10.0%   1.8 s     ~160MB
//   small.en      5.3%   5.7 s     ~375MB
//   parakeet-v3   4.0%   1.1 s     ~670MB (25 European languages)
// Clean read speech: a laptop mic in a room does worse for every model.
//
// Files live at ~/.lax/models/<variant dir>/ and are pulled from the
// variant's csukuangfj/sherpa-onnx-* repo on first use.

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { DESKTOP_ENV } from "../desktop-contract/env.js";
import { isLocalOnlyMode, LOCAL_ONLY_BLOCK_MESSAGE } from "../local-only-policy.js";

export type WhisperVariant = "tiny.en" | "base.en" | "small.en" | "parakeet-v3";

/** How sherpa-onnx loads the variant: Whisper is encoder + decoder, NeMo's
 *  Parakeet is a transducer (encoder + decoder + joiner). */
export type LocalSttKind = "whisper" | "nemo_transducer";

export const VALID_WHISPER_VARIANTS: ReadonlySet<WhisperVariant> =
  new Set<WhisperVariant>(["tiny.en", "base.en", "small.en", "parakeet-v3"]);

export const DEFAULT_WHISPER_VARIANT: WhisperVariant = "tiny.en";

export function resolveWhisperVariant(opts?: { variant?: WhisperVariant }): WhisperVariant {
  if (opts?.variant && VALID_WHISPER_VARIANTS.has(opts.variant)) return opts.variant;
  const envRaw = process.env.LAX_VOICE_WHISPER_MODEL?.toLowerCase().trim();
  if (envRaw && VALID_WHISPER_VARIANTS.has(envRaw as WhisperVariant)) {
    return envRaw as WhisperVariant;
  }
  return whisperDownloadState("parakeet-v3").cached ? "parakeet-v3" : DEFAULT_WHISPER_VARIANT;
}

interface ModelFile { name: string; url: string; minBytes: number; }

type FileRole = "encoder" | "decoder" | "joiner" | "tokens";

interface VariantSpec {
  kind: LocalSttKind;
  repo: string;
  dir: string;
  /** File name + truncation guard per role. */
  files: Partial<Record<FileRole, [string, number]>>;
}

// Truncation guards are ~60% of the real int8 size. sherpa-onnx re-verifies
// ONNX integrity on load, so these only catch obviously truncated downloads.
function whisperSpec(v: "tiny.en" | "base.en" | "small.en", encoder: number, decoder: number): VariantSpec {
  return {
    kind: "whisper",
    repo: `csukuangfj/sherpa-onnx-whisper-${v}`,
    dir: `whisper-${v.replace(".", "-")}`,
    files: {
      encoder: [`${v}-encoder.int8.onnx`, encoder],
      decoder: [`${v}-decoder.int8.onnx`, decoder],
      tokens: [`${v}-tokens.txt`, 100_000],
    },
  };
}

const VARIANT_SPECS: Record<WhisperVariant, VariantSpec> = {
  "tiny.en": whisperSpec("tiny.en", 8_000_000, 50_000_000),
  "base.en": whisperSpec("base.en", 14_000_000, 55_000_000),
  "small.en": whisperSpec("small.en", 50_000_000, 180_000_000),
  "parakeet-v3": {
    kind: "nemo_transducer",
    repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    dir: "parakeet-tdt-0.6b-v3",
    files: {
      encoder: ["encoder.int8.onnx", 400_000_000],
      decoder: ["decoder.int8.onnx", 7_000_000],
      joiner: ["joiner.int8.onnx", 4_000_000],
      tokens: ["tokens.txt", 50_000],
    },
  },
};

function modelDirFor(variant: WhisperVariant): string {
  // When LAX_BUNDLED_MODELS_DIR is set AND it contains the variant we
  // want, use the bundled copy — saves the first-run download. The
  // desktop main process sets this to electron's process.resourcesPath
  // when packaged. Only the default (tiny.en) is bundled today; others
  // fall through to the normal ~/.lax/models download path.
  const dir = VARIANT_SPECS[variant].dir;
  const bundled = process.env[DESKTOP_ENV.BUNDLED_MODELS_DIR];
  if (bundled) {
    const bundledDir = join(bundled, dir);
    if (existsSync(bundledDir)) return bundledDir;
  }
  return join(getLaxDir(), "models", dir);
}

function modelFilesFor(variant: WhisperVariant): ModelFile[] {
  const spec = VARIANT_SPECS[variant];
  const base = `https://huggingface.co/${spec.repo}/resolve/main`;
  return Object.values(spec.files).map(([name, minBytes]) => ({ name, url: `${base}/${name}`, minBytes }));
}

export interface WhisperModelPaths {
  encoder: string;
  decoder: string;
  /** Set for transducer variants only. */
  joiner?: string;
  tokens: string;
  modelDir: string;
  variant: WhisperVariant;
  kind: LocalSttKind;
}

export function getWhisperModelPaths(opts?: { variant?: WhisperVariant }): WhisperModelPaths {
  const variant = resolveWhisperVariant(opts);
  const modelDir = modelDirFor(variant);
  const { kind, files } = VARIANT_SPECS[variant];
  const at = (role: FileRole) => join(modelDir, files[role]![0]);
  return {
    variant,
    kind,
    modelDir,
    encoder: at("encoder"),
    decoder: at("decoder"),
    ...(files.joiner ? { joiner: at("joiner") } : {}),
    tokens: at("tokens"),
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

interface InFlight {
  promise: Promise<WhisperModelPaths>;
  listeners: Set<(p: WhisperFetchProgress) => void>;
  overallPct: number;
}

// One download per variant at a time. A voice session starting while the
// Local tier's download runs would otherwise open a second writer on the
// same files and corrupt them; it joins the running download instead.
const inFlight = new Map<WhisperVariant, InFlight>();
/** Why the last download of a variant failed, until the next one starts. */
const lastFailure = new Map<WhisperVariant, string>();

export interface WhisperDownloadState {
  cached: boolean;
  downloading: boolean;
  overallPct: number;
  error?: string;
}

/** Whether a variant is on disk, downloading now (and how far along), or
 *  failed its last download. */
export function whisperDownloadState(variant: WhisperVariant): WhisperDownloadState {
  const f = inFlight.get(variant);
  if (f) return { cached: false, downloading: true, overallPct: Math.round(f.overallPct) };
  const error = lastFailure.get(variant);
  return { cached: whisperModelExists({ variant }), downloading: false, overallPct: 0, ...(error ? { error } : {}) };
}

export async function ensureWhisperModelDownloaded(
  onProgress?: (p: WhisperFetchProgress) => void,
  opts?: { variant?: WhisperVariant },
): Promise<WhisperModelPaths> {
  const variant = resolveWhisperVariant(opts);
  // A file still being written can already pass the size check, so a running
  // download is joined, never taken as done.
  if (!inFlight.has(variant) && whisperModelExists({ variant })) return getWhisperModelPaths({ variant });
  if (isLocalOnlyMode()) throw new Error(LOCAL_ONLY_BLOCK_MESSAGE);

  let flight = inFlight.get(variant);
  if (!flight) {
    lastFailure.delete(variant);
    const started = { listeners: new Set(), overallPct: 0 } as InFlight;
    started.promise = downloadVariant(variant, (p) => {
      started.overallPct = p.overallPct;
      for (const l of started.listeners) l(p);
    }).catch((e: Error) => {
      lastFailure.set(variant, e.message);
      throw e;
    }).finally(() => inFlight.delete(variant));
    inFlight.set(variant, started);
    flight = started;
  }
  if (onProgress) flight.listeners.add(onProgress);
  try {
    return await flight.promise;
  } finally {
    if (onProgress) flight.listeners.delete(onProgress);
  }
}

async function downloadVariant(
  variant: WhisperVariant,
  onProgress: (p: WhisperFetchProgress) => void,
): Promise<WhisperModelPaths> {
  const paths = getWhisperModelPaths({ variant });
  const files = modelFilesFor(variant);
  mkdirSync(paths.modelDir, { recursive: true });

  let overallTotal = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.url, { method: "HEAD", redirect: "follow" });
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      overallTotal += len > 0 ? len : f.minBytes * 2;
    } catch { overallTotal += f.minBytes * 2; }
  }

  let overallSoFar = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const outPath = join(paths.modelDir, f.name);
    try {
      await downloadOne(f, outPath, i, files.length, overallSoFar, overallTotal, onProgress);
      overallSoFar += statSync(outPath).size;
    } catch (e) {
      try { unlinkSync(outPath); } catch {}
      throw new Error(`Speech model download failed for ${f.name}: ${(e as Error).message}`);
    }
  }

  if (!whisperModelExists({ variant })) {
    throw new Error("Speech model download completed but sanity-check failed");
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
  onProgress: (p: WhisperFetchProgress) => void,
): Promise<void> {
  const res = await fetch(file.url, { redirect: "follow" });
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
    const bytesTotal = fileLen > 0 ? fileLen : file.minBytes * 2;
    const overallPct = overallTotal > 0 ? ((overallSoFar + written) / overallTotal) * 100 : 0;
    onProgress({
      file: file.name,
      fileIndex: idx, fileCount: total,
      bytesDownloaded: written, bytesTotal,
      overallPct: Math.min(100, overallPct),
    });
  }
  await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => err ? reject(err) : resolve()));

  if (fileLen > 0 && written < fileLen) {
    throw new Error(`truncated — got ${written} of ${fileLen} bytes`);
  }
}
