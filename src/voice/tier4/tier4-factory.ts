// Public Tier 4 entry — used by src/voice/voice-session.ts when LAX_VOICE_TIER=4.
//
// ARCHITECTURE
// ============
// Adapters live behind a string-keyed registry (registry.ts). Each provider
// auto-registers itself when this module imports it. createTier4() then
// dispatches via createTtsProvider(name, ...).
//
// Built-in providers:
//   - "kokoro"            (streaming-tts.ts, default)
//   - "chatterbox-clone"  (chatterbox-clone-stub.ts, opt-in via LAX_VOICE_CLONE_REF)
//   - "edge-tts"          (edge-tts-adapter.ts, cloud Edge Read-Aloud)
//
// SELECTION (env)
// ===============
// When LAX_VOICE_TIER4_PROVIDER=edge-tts, voice-session dispatches via
// createTtsProvider("edge-tts", ...). Otherwise the existing logic decides
// between "kokoro" and "chatterbox-clone" based on LAX_VOICE_CLONE_REF.
//
// The voice-session.ts wiring will read LAX_VOICE_TIER4_PROVIDER and pass it
// through to createTier4 via opts.variant — no shape change to this file's
// exports. tier4Readiness() still reports the kokoro install state so the
// existing UI tier-card keeps rendering correctly; the new listTtsProviders()
// is what the UI will call once provider-pick UX lands.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTier4StreamingTTS as createKokoroPath } from "./streaming-tts.js";
import { createChatterboxClonePath } from "./chatterbox-clone-stub.js";
import { createEdgeTtsProvider, edgeTtsReadiness } from "./edge-tts-adapter.js";
import type { Tier4Callbacks, Tier4Config, Tier4Device, Tier4Dtype, Tier4StreamingTTS } from "./types.js";
import { TIER4_DEFAULTS } from "./types.js";
import { envDevice, envDtype } from "./env.js";
import {
  registerTtsProvider,
  createTtsProvider,
  listTtsProviders as listProvidersFromRegistry,
} from "./registry.js";

// Built-in provider auto-registration. Side-effectful imports above pull each
// adapter into the bundle; the calls below wire them into the registry. Tier 5
// adapters can either register here or self-register from their own module.
registerTtsProvider("kokoro", (opts, cb) => createKokoroPath(opts, cb));
registerTtsProvider("chatterbox-clone", (opts, cb) =>
  createChatterboxClonePath({ ...opts, referenceWavPath: opts.referenceWavPath }, cb),
);
registerTtsProvider("edge-tts", (opts, cb) => createEdgeTtsProvider(opts, cb), edgeTtsReadiness);

// Variant key is now an open string so external adapters can register their
// own. Kept the union members for back-compat call sites.
export type Tier4Variant = "kokoro" | "chatterbox-clone" | "edge-tts" | (string & {});

export interface CreateTier4Options extends Tier4Config {
  variant?: Tier4Variant;
  referenceWavPath?: string;
}

export async function createTier4(
  opts: CreateTier4Options,
  cb: Tier4Callbacks,
): Promise<Tier4StreamingTTS> {
  const variant: Tier4Variant = opts.variant ?? "kokoro";
  return createTtsProvider(variant, opts, cb);
}

export function tier4Enabled(): boolean {
  return process.env.LAX_VOICE_TIER === "4";
}

export function tier4VariantFromEnv(): Tier4Variant {
  const explicit = process.env.LAX_VOICE_TIER4_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
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
  requestedDevice: Tier4Device;
  requestedDtype: Tier4Dtype;
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
    requestedDevice: envDevice() ?? TIER4_DEFAULTS.device,
    requestedDtype: envDtype() ?? TIER4_DEFAULTS.dtype,
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

/** Lightweight provider listing for the UI provider-picker. */
export function listTtsProviders(): { name: string; ready: boolean; reason?: string }[] {
  return listProvidersFromRegistry();
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
