// STT provider registry + dispatcher.
//
// Selection precedence (resolved by caller, typically voice-session):
//   1. explicit `name` argument to createSttProvider
//   2. process.env.LAX_VOICE_STT_PROVIDER
//   3. "local-whisper" (default — keeps existing behavior on installs that
//      don't opt into cloud STT)
//
// IMPORTANT: this module owns dispatch only. Wiring into voice-session is
// done separately (don't import this from voice-session yet — the consumer
// is being updated in a follow-up commit).

import { createWhisperTranscriber, type WhisperTranscriber, type WhisperTranscriberOptions } from "../whisper-stream.js";
import type { WhisperModelPaths } from "../whisper-model-fetch.js";

import type { SttProviderConfig, SttProviderName } from "./types.js";
import { createGroqTranscriber } from "./groq.js";
import { createOpenAITranscriber } from "./openai.js";
import { createMistralTranscriber } from "./mistral.js";
import { getSecretsStoreSingleton } from "../../secrets.js";

// Re-export the existing local impl so callers can import it via this
// barrel. We deliberately don't wrap it: the local path needs model paths
// which the cloud path doesn't, so duplicating the call signature would
// lose type info.
export { createWhisperTranscriber } from "../whisper-stream.js";

export type { SttProviderName, SttProviderConfig } from "./types.js";
export { pcmToWav } from "./wav-encoder.js";
export { isWhisperHallucination } from "./hallucination-filter.js";

/** Local-whisper variant of createSttProvider — needs model paths. */
export interface LocalSttOpts extends WhisperTranscriberOptions {
  paths: WhisperModelPaths;
}

const VALID_NAMES: ReadonlySet<SttProviderName> = new Set<SttProviderName>([
  "local-whisper", "groq", "openai", "mistral",
]);

/** The name each cloud provider's key is saved under, in Settings → Secrets
 *  and in the environment. */
export const STT_KEY_NAME = { groq: "GROQ_API_KEY", openai: "OPENAI_API_KEY", mistral: "MISTRAL_API_KEY" } as const;

/** A cloud provider's config with the key saved in Settings → Secrets filled in
 *  when the caller passed none. Every caller gets it, so a saved key works on
 *  each voice path, not only the one that looked it up; with nothing saved, the
 *  provider reads its own environment variables. */
function withSavedKey(name: keyof typeof STT_KEY_NAME, cfg: SttProviderConfig = {}): SttProviderConfig {
  if (cfg.apiKey) return cfg;
  const saved = getSecretsStoreSingleton()?.get(STT_KEY_NAME[name]);
  return saved ? { ...cfg, apiKey: saved } : cfg;
}

/** Validate + normalize the provider env knob. Returns undefined on miss. */
export function resolveSttProviderName(): SttProviderName | undefined {
  const raw = process.env.LAX_VOICE_STT_PROVIDER;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  return VALID_NAMES.has(v as SttProviderName) ? (v as SttProviderName) : undefined;
}

/**
 * Build a transcriber for the given provider.
 *
 * Local whisper requires model paths — pass them on `opts` when
 * `name === "local-whisper"`. Cloud providers ignore `opts.paths` and read
 * `opts.cloud` (apiKey/model/baseUrl/language/timeoutMs) instead.
 */
export function createSttProvider(
  name: SttProviderName,
  opts: { local?: LocalSttOpts; cloud?: SttProviderConfig } = {},
): WhisperTranscriber {
  switch (name) {
    case "local-whisper": {
      if (!opts.local?.paths) {
        throw new Error("local-whisper requires opts.local.paths (call ensureWhisperModelDownloaded first).");
      }
      const { paths, ...rest } = opts.local;
      return createWhisperTranscriber(paths, rest);
    }
    case "groq":
      return createGroqTranscriber(withSavedKey("groq", opts.cloud));
    case "openai":
      return createOpenAITranscriber(withSavedKey("openai", opts.cloud));
    case "mistral":
      return createMistralTranscriber(withSavedKey("mistral", opts.cloud));
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown STT provider: ${String(exhaustive)}`);
    }
  }
}
