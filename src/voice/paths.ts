// Local voice-engine binaries + model paths. Windows whisper.cpp builds put
// the binary under Release/ (MSVC layout) and use .exe; Mac/Linux builds
// drop a plain binary alongside the build dir. Kokoro / Piper / Chatterbox /
// SoVITS all live under ~/.lax/workspace/voice-chat/.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { randomBytes } from "node:crypto";

export const IS_WIN = process.platform === "win32";
export const VOICE_DIR = join(getLaxDir(), "workspace", "voice-chat");

export const WHISPER_EXE = IS_WIN
  ? join(VOICE_DIR, "whisper-bin", "Release", "whisper-cli.exe")
  : join(VOICE_DIR, "whisper-bin", "whisper-cli");
export const WHISPER_MODEL = join(VOICE_DIR, "whisper-bin", "models", "ggml-base.en.bin");

export const PIPER_EXE = IS_WIN
  ? join(VOICE_DIR, "piper", "piper", "piper.exe")
  : join(VOICE_DIR, "piper", "piper", "piper");
export const PIPER_VOICE = join(VOICE_DIR, "piper", "voices", "en_US-ryan-medium.onnx");

export const KOKORO_MODEL = join(VOICE_DIR, "kokoro", "kokoro-v1.0.onnx");
export const KOKORO_VOICES = join(VOICE_DIR, "kokoro", "voices-v1.0.bin");

export const TMP_DIR = join(getLaxDir(), "voice-tmp");
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

export function tmpPath(ext: string): string {
  return join(TMP_DIR, `${randomBytes(6).toString("hex")}.${ext}`);
}
