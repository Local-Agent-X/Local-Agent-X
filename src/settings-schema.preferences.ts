/**
 * Preferences the Settings page and the chat UI save through POST
 * /api/settings that the server runtime never mirrors into config.json:
 * appearance, onboarding, voice, and memory embeddings. The renderer, the
 * voice pipeline (voice/voice-session/settings.ts) and the memory index read
 * them from settings.json directly, and ignore a value they do not recognize.
 *
 * Part of FLIPPABLE_SETTINGS (settings-schema.ts); every key public/js posts is
 * declared somewhere in it (settings-schema.ui-posts.test.ts).
 */
import { z } from "zod";
import type { FlippableSetting } from "./settings-schema.js";
import { SPEED_MIN, SPEED_MAX } from "./voice/tier4/env.js";

/** A voice choice the UI clears by sending null or an empty string. */
const clearable = z.string().nullable();

// A setting that decides which outside service receives the user's memory
// text, microphone audio or replies is the user's: the agent may move it only
// toward keeping that data on this machine (settings-change-direction.ts).
const MEMORY_EMBEDDINGS = "Settings → Memory → Memory Embeddings";
const VOICE_SYSTEM = "Settings → Media → Voice System";

export const PREFERENCE_SETTINGS: ReadonlyArray<FlippableSetting> = [
  {
    field: "palette",
    owner: "agent",
    validate: z.enum(["aurora", "forge", "phosphor", "nebula", "cobalt", "bloom", "graphite"]),
    runtime: false,
    description: "Accent palette applied across the app, in both light and dark mode",
  },
  {
    field: "onboarded",
    owner: "agent",
    validate: z.boolean(),
    runtime: false,
    description: "Whether the first-run setup wizard has been completed",
  },
  {
    field: "agentFeedsAutoOpen",
    owner: "agent",
    validate: z.boolean(),
    runtime: false,
    description: "Whether the AGENTS panel opens by itself whenever an agent spawns. On by default",
  },
  {
    field: "embeddingProvider",
    owner: "protected", where: MEMORY_EMBEDDINGS,
    validate: z.enum(["local", "ollama", "openai", "gemini"]),
    runtime: false,
    description: "Embedding backend for memory search. local=built-in, no network; ollama=a local Ollama model; openai/gemini send memory text to that provider's API",
  },
  {
    field: "embeddingModel",
    owner: "protected", where: MEMORY_EMBEDDINGS,
    validate: z.string(),
    runtime: false,
    description: "Model name within embeddingProvider. Empty = that provider's default",
  },
  {
    field: "voiceEngine",
    owner: "agent",
    validate: z.enum(["tier4", "python", "cpu_fallback"]),
    runtime: false,
    description: "Voice backend. tier4=in-process, python=the installed voice sidecar, cpu_fallback=slow CPU-only engine",
  },
  {
    field: "voiceMode",
    owner: "protected", where: VOICE_SYSTEM,
    validate: z.enum(["browser", "standard"]),
    runtime: false,
    description: "Voice chat tier. browser=the browser's own speech recognition and voices; standard=the server voice pipeline",
  },
  {
    field: "voiceTier4Provider",
    owner: "protected", where: VOICE_SYSTEM,
    validate: z.string(),
    runtime: false,
    description: "Text-to-speech provider for spoken replies (browser, edge-tts, kokoro). Empty = the engine's default. edge-tts sends reply text to Microsoft",
  },
  {
    field: "voiceSttProvider",
    owner: "protected", where: VOICE_SYSTEM,
    validate: z.string(),
    runtime: false,
    description: "Speech-to-text provider (browser, local-whisper, groq, openai, mistral). Empty = the engine's default. groq/openai/mistral send microphone audio to that provider",
  },
  {
    field: "ttsVoice",
    owner: "agent",
    validate: z.string(),
    runtime: false,
    description: "Voice every transport speaks with by default: a voice id, or a vx:/cb: cloned-voice reference",
  },
  {
    field: "voiceTier4Voice",
    owner: "agent",
    validate: z.string(),
    runtime: false,
    description: "Voice id for the voiceTier4Provider. Empty = that provider's default",
  },
  {
    field: "voiceRealtimeVoice",
    owner: "agent",
    validate: z.string(),
    runtime: false,
    description: "Voice for the realtime voice bridge. Empty = its default",
  },
  {
    field: "voiceTier4Speed",
    owner: "agent",
    validate: z.number().min(SPEED_MIN).max(SPEED_MAX),
    runtime: false,
    description: `Speaking rate for spoken replies (${SPEED_MIN}-${SPEED_MAX})`,
  },
  {
    field: "voiceTier4Device",
    owner: "agent",
    validate: clearable,
    runtime: false,
    description: "Device the in-process TTS runs on (cpu, wasm, webgpu, dml, cuda, auto). null = auto",
  },
  {
    field: "voiceTier4Dtype",
    owner: "agent",
    validate: clearable,
    runtime: false,
    description: "Numeric precision of the in-process TTS model (fp32, fp16, q8, q4, q4f16). null = auto",
  },
  {
    field: "voiceWhisperModel",
    owner: "agent",
    validate: clearable,
    runtime: false,
    description: "Local Whisper model size for speech-to-text. null = auto (tiny.en)",
  },
  {
    field: "voiceWhisperDevice",
    owner: "agent",
    validate: clearable,
    runtime: false,
    description: "Device local Whisper runs on. null = auto",
  },
  {
    field: "voice_visuals_enabled",
    owner: "agent",
    validate: z.boolean(),
    runtime: false,
    description: "Whether voice replies show the animated visualizer. On by default",
  },
];
