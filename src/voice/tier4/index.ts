// Tier 4 native voice — barrel exports.
//
// The orchestrator only needs createTier4 + tier4Enabled to wire in.
// Everything else is exposed for tests, the voice-setup status route, and
// for tier 5 to extend later.

export {
  createTier4,
  tier4Enabled,
  tier4VariantFromEnv,
  tier4Readiness,
  tier4ModelDownloaded,
} from "./tier4-factory.js";
export type { CreateTier4Options, Tier4Variant, Tier4Readiness } from "./tier4-factory.js";

export { createTier4StreamingTTS, snapshotTier4Diag } from "./streaming-tts.js";
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
export { TIER4_DEFAULTS, TIER4_SAMPLE_RATE } from "./types.js";

export { KOKORO_VOICES, isValidKokoroVoice, kokoroVoiceMeta, kokoroVoiceList } from "./kokoro-voices.js";
export type { KokoroVoiceMeta } from "./kokoro-voices.js";

export { registerTtsProvider, hasTtsProvider, createTtsProvider, listTtsProviders } from "./registry.js";
export type { TtsProviderFactory, TtsProviderOptions, TtsProviderEntry } from "./registry.js";

export { EDGE_VOICES, EDGE_DEFAULT_VOICE, isCuratedEdgeVoice, edgeVoiceList } from "./edge-voices.js";
export { createEdgeTtsProvider, edgeTtsReadiness } from "./edge-tts-adapter.js";
