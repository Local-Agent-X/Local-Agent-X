// Tier 4 native voice — barrel exports.
//
// The orchestrator only needs createTier4 + tier4Enabled to wire in.
// Everything else is exposed for tests and for tier 5 to extend later.

export { createTier4, tier4Enabled, tier4VariantFromEnv } from "./tier4-factory.js";
export type { CreateTier4Options, Tier4Variant } from "./tier4-factory.js";

export { createTier4StreamingTTS } from "./streaming-tts.js";
export { createKokoroEngine, float32ToInt16 } from "./kokoro-engine.js";
export type { KokoroEngine, KokoroEngineInit } from "./kokoro-engine.js";

export {
  configureHFCache,
  getTier4CacheDir,
  loadReferenceWav24kMono,
  tier4ModelStatus,
} from "./voice-clone-loader.js";
export type { Tier4ModelStatus } from "./voice-clone-loader.js";

export type {
  Tier4Callbacks,
  Tier4Config,
  Tier4DiagSnapshot,
  Tier4Device,
  Tier4Dtype,
  Tier4StreamingTTS,
} from "./types.js";
export { TIER4_DEFAULTS } from "./types.js";
