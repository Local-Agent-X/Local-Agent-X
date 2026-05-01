// Shared env-var helpers for tier 4. Both the kokoro engine (runtime) and
// the readiness probe (UI status) need to know what the user opted into via
// LAX_VOICE_TIER4_*, so the parsing/validation lives here once.

import type { Tier4Device, Tier4Dtype } from "./types.js";

export const VALID_DEVICES: ReadonlySet<Tier4Device> = new Set<Tier4Device>([
  "cpu", "wasm", "webgpu", "dml", "cuda", "auto",
]);

export const VALID_DTYPES: ReadonlySet<Tier4Dtype> = new Set<Tier4Dtype>([
  "fp32", "fp16", "q8", "q4", "q4f16",
]);

// Kokoro's `speed` param is a synthesis-time time-stretch. Values <0.5 sound
// drunk and unnatural; >2.0 turns into chipmunk and the phoneme model breaks
// down. Clamp at the same range the kokoro-js docs recommend.
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;

export function envDevice(): Tier4Device | undefined {
  const v = process.env.LAX_VOICE_TIER4_DEVICE?.toLowerCase() as Tier4Device | undefined;
  return v && VALID_DEVICES.has(v) ? v : undefined;
}

export function envDtype(): Tier4Dtype | undefined {
  const v = process.env.LAX_VOICE_TIER4_DTYPE?.toLowerCase() as Tier4Dtype | undefined;
  return v && VALID_DTYPES.has(v) ? v : undefined;
}

export function envVoice(): string | undefined {
  const v = process.env.LAX_VOICE_TIER4_VOICE;
  return v && v.length > 0 ? v : undefined;
}

export function envSpeed(): number | undefined {
  const raw = process.env.LAX_VOICE_TIER4_SPEED;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < SPEED_MIN || n > SPEED_MAX) return undefined;
  return n;
}
