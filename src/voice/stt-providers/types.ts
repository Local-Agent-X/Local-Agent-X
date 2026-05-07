// Shared types for cloud STT providers.
//
// All providers implement the same WhisperTranscriber contract defined in
// ../whisper-stream.ts so voice-session can swap between local sherpa-onnx
// Whisper and cloud APIs without touching call sites.
//
// Selection at runtime is driven by env LAX_VOICE_STT_PROVIDER
// (one of: local-whisper | groq | openai | mistral). Wiring lives in
// voice-session.ts; this module only owns provider construction.

import type { WhisperTranscriber } from "../whisper-stream.js";

export type SttProviderName = "local-whisper" | "groq" | "openai" | "mistral";

export interface SttProviderConfig {
  /** Override API key. Falls back to provider-specific env var if absent. */
  apiKey?: string;
  /** Override model id. Each provider picks a sensible default. */
  model?: string;
  /** Override base URL. Useful for proxies or self-hosted gateways. */
  baseUrl?: string;
  /** Two-letter ISO language hint (e.g. "en"). Optional. */
  language?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export type SttProviderFactory = (
  cfg?: SttProviderConfig,
) => WhisperTranscriber;
