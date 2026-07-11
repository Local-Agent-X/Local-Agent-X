// Detect which STT/TTS engines are installed on the host. Probed at boot
// + before each unified synthesize() call so the routing chain knows which
// tier to start at.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  WHISPER_EXE, WHISPER_MODEL,
  PIPER_EXE, PIPER_VOICE,
  KOKORO_MODEL, KOKORO_VOICES,
} from "./paths.js";

export interface VoiceCapabilities {
  stt: "whisper" | "none";
  tts: "kokoro" | "piper" | "none";
  whisperModel: string;
  ttsVoice: string;
}

export async function detectCapabilities(): Promise<VoiceCapabilities> {
  const stt = existsSync(WHISPER_EXE) && existsSync(WHISPER_MODEL) ? "whisper" as const : "none" as const;

  let tts: "kokoro" | "piper" | "none" = "none";
  let ttsVoice = "";

  // Kokoro (best quality) — Python module gate, not just files on disk.
  if (existsSync(KOKORO_MODEL) && existsSync(KOKORO_VOICES)) {
    try {
      execSync('python -c "from kokoro_onnx import Kokoro"', { timeout: 10000, stdio: "ignore" });
      tts = "kokoro";
      ttsVoice = "am_onyx";
    } catch {
      // Kokoro Python module not installed
    }
  }

  if (tts === "none" && existsSync(PIPER_EXE) && existsSync(PIPER_VOICE)) {
    tts = "piper";
    ttsVoice = "en_US-ryan-medium";
  }

  return {
    stt,
    tts,
    whisperModel: stt === "whisper" ? "base.en" : "",
    ttsVoice,
  };
}
