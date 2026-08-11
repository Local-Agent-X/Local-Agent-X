// Canonical list of KittenTTS 0.1 nano voice IDs.
//
// KittenTTS ships eight expressive style vectors as voices/<id>.bin in the
// model repo (onnx-community/kitten-tts-nano-0.1-ONNX). Each .bin is exactly
// 1024 bytes = 256 float32 = one StyleTTS2 style vector (no per-length lookup
// table like Kokoro's larger bins). Mirrors kokoro-voices.ts so an invalid
// voice fails fast at settings-resolution time instead of at synth time.
//
// Source of truth: onnx-community/kitten-tts-nano-0.1-ONNX voices/ directory.

export const KITTEN_VOICES: ReadonlySet<string> = new Set<string>([
  "expr-voice-2-m", "expr-voice-2-f",
  "expr-voice-3-m", "expr-voice-3-f",
  "expr-voice-4-m", "expr-voice-4-f",
  "expr-voice-5-m", "expr-voice-5-f",
]);

// expr-voice-2-m is the natural male default. AVOID expr-voice-5-m — the bench
// found it renders unnaturally slow.
export const KITTEN_DEFAULT_VOICE = "expr-voice-2-m";

export function isValidKittenVoice(v: string | undefined | null): boolean {
  return typeof v === "string" && KITTEN_VOICES.has(v);
}

// Voice ID convention: expr-voice-<n>-<gender>, gender = m | f.
export interface KittenVoiceMeta {
  id: string;
  gender: "female" | "male" | "unknown";
}

export function kittenVoiceMeta(id: string): KittenVoiceMeta {
  const g = id.endsWith("-m") ? "male" : id.endsWith("-f") ? "female" : "unknown";
  return { id, gender: g };
}

export function kittenVoiceList(): KittenVoiceMeta[] {
  return [...KITTEN_VOICES].map(kittenVoiceMeta);
}
