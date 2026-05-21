// Public surface for the voice pipeline. Legacy `src/voice.ts` re-exports
// from here so existing callers (audio-agent, telegram-bridge,
// whatsapp-bridge) don't need to update import paths.

export { applyEQPreset, listEQPresets } from "./eq-presets.js";
export type { EQPreset } from "./eq-presets.js";
export { registerTTSProcess, interruptSpeech, wasTTSInterrupted } from "./tts-interruption.js";
export { detectCapabilities } from "./capabilities.js";
export type { VoiceCapabilities } from "./capabilities.js";
export { transcribe, whisperTranscribe, multiLanguageTranscribe } from "./stt.js";
export type { WhisperModel } from "./stt.js";
export { synthesizeKokoro, synthesizePiper } from "./tts-local.js";
export { continuousListen } from "./continuous-listen.js";
export type { ContinuousListenOptions } from "./continuous-listen.js";
export { synthesize } from "./tts-synthesize.js";
