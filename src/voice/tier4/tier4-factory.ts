// Public Tier 4 entry — used by src/voice/voice-session.ts when LAX_VOICE_TIER=4.
//
// Two reasons this lives in its own file:
//   (1) keeps streaming-tts.ts focused on the chunk-pump,
//   (2) gives one obvious place to add tier 5 (Chatterbox cloning) without
//       touching the kokoro engine.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTier4StreamingTTS as createKokoroPath } from "./streaming-tts.js";
import type { Tier4Callbacks, Tier4Config, Tier4StreamingTTS } from "./types.js";
import { TIER4_DEFAULTS } from "./types.js";

export type Tier4Variant = "kokoro" | "chatterbox-clone";

export interface CreateTier4Options extends Tier4Config {
  variant?: Tier4Variant;
  referenceWavPath?: string;
}

export async function createTier4(
  opts: CreateTier4Options,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  const variant: Tier4Variant = opts.variant ?? "kokoro";

  if (variant === "kokoro") {
    return createKokoroPath(opts, cb);
  }

  if (variant === "chatterbox-clone") {
    const stub = await import("./chatterbox-clone-stub.js");
    return stub.createChatterboxClonePath(opts, cb);
  }

  throw new Error(`unknown tier 4 variant: ${variant}`);
}

export function tier4Enabled(): boolean {
  return process.env.LAX_VOICE_TIER === "4";
}

export function tier4VariantFromEnv(): Tier4Variant {
  return process.env.LAX_VOICE_CLONE_REF ? "chatterbox-clone" : "kokoro";
}

/**
 * Cheap readiness probe for the UI's tier-status card. We check that the
 * runtime deps are resolvable from this repo without actually constructing
 * the engine (which would download the model). Returns enough metadata for
 * the card to render the right state.
 */
export interface Tier4Readiness {
  ready: boolean;
  hasKokoro: boolean;
  hasOnnxRuntime: boolean;
  defaultModelId: string;
  defaultVoice: string;
  defaultDevice: string;
  reason?: string;
}

export function tier4Readiness(): Tier4Readiness {
  const result: Tier4Readiness = {
    ready: false,
    hasKokoro: false,
    hasOnnxRuntime: false,
    defaultModelId: TIER4_DEFAULTS.modelId,
    defaultVoice: TIER4_DEFAULTS.voice,
    defaultDevice: TIER4_DEFAULTS.device,
  };
  // resolve kokoro-js + onnxruntime-node lazily; createRequire avoids hard-
  // crashing the host when running outside the repo (e.g. unit tests).
  const req = createRequire(import.meta.url);
  try {
    req.resolve("kokoro-js");
    result.hasKokoro = true;
  } catch { result.reason = "kokoro-js not installed (npm i kokoro-js)"; }
  try {
    req.resolve("onnxruntime-node");
    result.hasOnnxRuntime = true;
  } catch {
    if (!result.reason) result.reason = "onnxruntime-node not installed";
  }
  result.ready = result.hasKokoro && result.hasOnnxRuntime;
  return result;
}

/**
 * Best-effort lookup for whether the model weights have been downloaded yet.
 * Reads from the same cache root the engine uses (~/.lax/models/tts/kokoro-onnx).
 */
export async function tier4ModelDownloaded(modelId = TIER4_DEFAULTS.modelId): Promise<{
  cached: boolean;
  cacheDir: string;
  approxBytes: number;
}> {
  const { tier4ModelStatus, getTier4CacheDir } = await import("./voice-clone-loader.js");
  const cacheDir = getTier4CacheDir();
  const status = tier4ModelStatus(modelId);
  // Sanity: the per-model probe lives in voice-clone-loader; if it doesn't
  // see weights yet, double-check the cache root itself for any payload at
  // all — useful for debugging when HF_HOME got pointed elsewhere.
  if (!status.cached && existsSync(join(cacheDir, "models--onnx-community--Kokoro-82M-v1.0-ONNX"))) {
    return { cached: true, cacheDir, approxBytes: status.approxBytes };
  }
  return status;
}
