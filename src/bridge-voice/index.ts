// Bridge-voice barrel — keeps imports in telegram-bridge / whatsapp-bridge
// flat and makes the surface area for the bridge-side voice stack obvious.

export { decodeOggToPcm16, encodeWavToOgg, isFfmpegAvailable } from "./audio-codec.js";
export { transcribeOggBuffer } from "./stt-helper.js";
export { getVoicePref, setVoicePref, type BridgePlatform } from "./voice-prefs.js";
export { splitForVoiceChunks } from "./chunk-text.js";
