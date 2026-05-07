// Filter known-bad Whisper outputs.
//
// Whisper-family models (local sherpa-onnx whisper, Groq whisper-large-v3,
// OpenAI whisper-1) hallucinate the same canned phrases on silence,
// noise, and very short utterances — the training set was crawled from
// YouTube subtitles so the priors are dominated by closed-caption boilerplate.
// We compare the trimmed lowercase transcript against a curated list and
// drop exact matches.
//
// We deliberately keep this list short and exact-match: aggressive fuzzy
// matching would suppress legitimate utterances like a real "thank you".

const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set<string>([
  "thanks for watching!",
  "thanks for watching",
  "thank you for watching",
  "thank you for watching.",
  "thanks for watching, please subscribe.",
  "please subscribe",
  "please like and subscribe.",
  "subtitles by",
  "subtitles by the amara.org community",
  "subtitled by the amara.org community",
  "[music]",
  "[ music ]",
  "(music)",
  "[applause]",
  "[silence]",
  "[no audio]",
  "you",
  "you.",
  "thank you.",
  "thank you",
  "bye.",
  "bye bye",
  ".",
]);

/**
 * Return true when `text` is a known Whisper hallucination artifact and
 * should be discarded. Empty/whitespace-only inputs also return true.
 */
export function isWhisperHallucination(text: string): boolean {
  if (!text) return true;
  const norm = text.trim().toLowerCase();
  if (!norm) return true;
  return HALLUCINATION_PHRASES.has(norm);
}
