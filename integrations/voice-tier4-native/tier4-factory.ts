// Public factory entry — call this from voice-session.ts when LAX_VOICE_TIER=4.
//
// Mirrors the shape of `createStreamingTTS` in src/voice/tts-stream.ts so the
// wire-in is one branch in voice-session.ts:
//
//   if (process.env.LAX_VOICE_TIER === "4") {
//     return createTier4StreamingTTS({ voice, speed }, callbacks);
//   }
//
// Two reasons this lives in its own file: (1) keeps streaming-tts.ts focused
// on the chunk-pump logic, (2) gives us one obvious place to add tier 5
// (Chatterbox cloning) when that ships, without touching the kokoro engine.

import { createTier4StreamingTTS as createKokoroPath } from "./streaming-tts.js";
import type { Tier4Callbacks, Tier4Config, Tier4StreamingTTS } from "./types.js";

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
