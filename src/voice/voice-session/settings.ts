// Voice settings resolution. Reads ~/.lax/settings.json on each session
// creation so the UI dropdown changes (engine, voice, device, dtype,
// speed, STT provider, realtime mode) flip the next voice session
// without a server restart.
//
// Precedence:
//   1. settings.voiceEngine (user choice, primary)
//   2. LAX_VOICE_TIER=4 → tier4
//   3. LAX_VOICE_GPU=0  → cpu_fallback (legacy Matcha)
//   4. default          → python (GPU sidecar, lite tier)
//
// Engine values (stable IDs — UI uses these as the dropdown values):
//   "tier4"        — native ONNX Kokoro, no Python, ~1.2s first-audio
//   "python"       — Python sidecar (GPU); sub-tier picked by the sidecar
//                    via its own LAX_VOICE_PORT (Lite 7008 / Pro 7009 /
//                    Studio 7010)
//   "cpu_fallback" — in-process Sherpa WASM + Matcha (slow, low quality,
//                    no Python or GPU needed — emergency fallback only)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import type { WhisperProvider } from "../whisper-stream.js";
import { VALID_WHISPER_PROVIDERS } from "../whisper-stream.js";
import type { WhisperVariant } from "../whisper-model-fetch.js";
import { VALID_WHISPER_VARIANTS } from "../whisper-model-fetch.js";
import { VALID_DEVICES as VALID_TIER4_DEVICES, VALID_DTYPES as VALID_TIER4_DTYPES, SPEED_MIN as TIER4_SPEED_MIN, SPEED_MAX as TIER4_SPEED_MAX } from "../tier4/env.js";
import { isValidKokoroVoice } from "../tier4/kokoro-voices.js";
import type { Tier4Device, Tier4Dtype } from "../tier4/types.js";

const logger = createLogger("voice.voice-session");

export type VoiceEngineId = "tier4" | "python" | "cpu_fallback";

export interface ResolvedVoiceSettings {
  engine: VoiceEngineId;
  /** "realtime" routes the whole session through OpenAI Realtime.
   *  Anything else (or undefined) keeps the standard STT + LLM + TTS
   *  pipeline. */
  mode?: "standard" | "realtime";
  tier4Device?: Tier4Device;
  tier4Dtype?: Tier4Dtype;
  tier4Voice?: string;
  tier4Speed?: number;
  /** Picks the TTS adapter when engine === "tier4". One of the keys in
   *  the registry (kokoro / chatterbox-clone / edge-tts / future). */
  tier4Provider?: string;
  whisperDevice?: WhisperProvider;
  whisperModel?: WhisperVariant;
  /** local-whisper / groq / openai / mistral / browser. */
  sttProvider?: string;
  /** alloy / echo / fable / onyx / nova / shimmer (only when mode=realtime). */
  realtimeVoice?: string;
  realtimeModel?: string;
}

export function resolveVoiceSettings(): ResolvedVoiceSettings {
  // Default for fresh users (no voice keys saved): tier4 in-process Kokoro.
  // Browser-only TTS routing happens client-side (the chat bar uses
  // window.speechSynthesis directly when voiceMode === "browser") — the
  // server side falls back to tier4 so the WebSocket path still works
  // for STT during the same session.
  const out: ResolvedVoiceSettings = { engine: "tier4" };
  let savedEngine: VoiceEngineId | undefined;
  try {
    const dataDir = process.env.LAX_DATA_DIR || join(homedir(), ".lax");
    const sp = join(dataDir, "settings.json");
    if (existsSync(sp)) {
      const saved = JSON.parse(readFileSync(sp, "utf-8")) as {
        voiceEngine?: string;
        voiceMode?: string;
        voiceTier4Device?: string;
        voiceTier4Dtype?: string;
        voiceTier4Voice?: string;
        voiceTier4Speed?: number;
        voiceTier4Provider?: string;
        voiceWhisperDevice?: string;
        voiceWhisperModel?: string;
        voiceSttProvider?: string;
        voiceRealtimeVoice?: string;
        voiceRealtimeModel?: string;
      };
      if (saved.voiceEngine === "tier4" || saved.voiceEngine === "python" || saved.voiceEngine === "cpu_fallback") {
        savedEngine = saved.voiceEngine;
      }
      const mode = saved.voiceMode?.trim().toLowerCase();
      if (mode === "realtime" || mode === "standard") out.mode = mode;
      const td = saved.voiceTier4Device?.toLowerCase() as Tier4Device | undefined;
      if (td && VALID_TIER4_DEVICES.has(td)) out.tier4Device = td;
      const tdt = saved.voiceTier4Dtype?.toLowerCase() as Tier4Dtype | undefined;
      if (tdt && VALID_TIER4_DTYPES.has(tdt)) out.tier4Dtype = tdt;
      const tp = saved.voiceTier4Provider?.trim().toLowerCase();
      if (tp) out.tier4Provider = tp;
      const tv = typeof saved.voiceTier4Voice === "string" ? saved.voiceTier4Voice.trim() : "";
      if (tv) {
        // Only the kokoro provider has a strict validation list;
        // pass-through for edge-tts / chatterbox-clone / future adapters
        // that own their own catalogs. Empty/unset provider is treated
        // as kokoro for back-compat with installs that never wrote
        // voiceTier4Provider.
        const isKokoro = !out.tier4Provider || out.tier4Provider === "kokoro";
        if (!isKokoro || isValidKokoroVoice(tv)) {
          out.tier4Voice = tv;
        } else {
          logger.warn(`[voice-session] settings.voiceTier4Voice="${tv}" is not a known Kokoro voice; using default`);
        }
      }
      const ts = saved.voiceTier4Speed;
      if (typeof ts === "number" && Number.isFinite(ts) && ts >= TIER4_SPEED_MIN && ts <= TIER4_SPEED_MAX) {
        out.tier4Speed = ts;
      }
      const wd = saved.voiceWhisperDevice?.toLowerCase() as WhisperProvider | undefined;
      if (wd && VALID_WHISPER_PROVIDERS.has(wd)) out.whisperDevice = wd;
      const wm = saved.voiceWhisperModel?.toLowerCase() as WhisperVariant | undefined;
      if (wm && VALID_WHISPER_VARIANTS.has(wm)) out.whisperModel = wm;
      const sp2 = saved.voiceSttProvider?.trim().toLowerCase();
      if (sp2) out.sttProvider = sp2;
      const rv = saved.voiceRealtimeVoice?.trim().toLowerCase();
      if (rv) out.realtimeVoice = rv;
      const rm = saved.voiceRealtimeModel?.trim();
      if (rm) out.realtimeModel = rm;
    }
  } catch { /* settings file unreadable — fall through to env */ }
  if (savedEngine) {
    out.engine = savedEngine;
  } else if (process.env.LAX_VOICE_TIER === "4") {
    out.engine = "tier4";
  } else if (process.env.LAX_VOICE_GPU === "0") {
    out.engine = "cpu_fallback";
  }
  return out;
}
