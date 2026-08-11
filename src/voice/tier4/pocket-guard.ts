// Pocket TTS over-generation guard.
//
// Pocket (like Sopro) pads short inputs: "Sure — that's done." (~1s of real
// speech) generated 3.7-6.3s of audio in the bench, trailing invented content
// past the text. This guard trims that tail. It only fires on CLEAR
// over-generation (output much longer than the text could plausibly take), and
// trims at a low-energy boundary so it never cuts mid-word on normal output.
//
// Pure + deterministic so it's unit-tested without the engine.

// Conversational TTS runs ~13-15 characters/sec. The cap = char-time + a small
// fixed allowance, floored so a 1-3 word reply still gets ~1.4s. Tight enough
// that a 1s phrase padded to 12s is cut to ~2s (the real words + a little),
// loose enough that a legitimately long sentence is never trimmed.
const CHARS_PER_SEC = 12;
const FIXED_ALLOWANCE_SEC = 0.8;  // onset + trailing breath
const FLOOR_SEC = 1.4;

/** Plausible upper bound on speech duration for `text`, in seconds. */
export function expectedMaxDurationSec(text: string): number {
  const chars = text.trim().length;
  return Math.max(FLOOR_SEC, chars / CHARS_PER_SEC + FIXED_ALLOWANCE_SEC);
}

/**
 * Trim over-generated trailing audio. Returns the input unchanged when the
 * audio is within the expected bound. When it overruns, trims back to the cap,
 * snapping to the last near-silent sample within a 400ms look-back so the cut
 * lands in a gap rather than mid-syllable. `onTrim` reports a fired guard.
 */
export function guardPocketAudio(
  text: string,
  audio: Float32Array,
  sampleRate: number,
  onTrim?: (info: { fromSec: number; toSec: number }) => void,
): Float32Array {
  if (sampleRate <= 0 || audio.length === 0) return audio;
  const durSec = audio.length / sampleRate;
  const capSec = expectedMaxDurationSec(text);
  if (durSec <= capSec) return audio;

  const capSample = Math.max(1, Math.floor(capSec * sampleRate));
  // Look back up to 400ms from the cap for a low-energy boundary (a gap between
  // words) so the cut isn't audible. Silence threshold is a small RMS floor.
  const lookback = Math.min(capSample, Math.floor(0.4 * sampleRate));
  const win = Math.max(1, Math.floor(0.01 * sampleRate)); // 10ms RMS window
  const SILENCE_RMS = 0.02;
  let cut = capSample;
  for (let i = capSample; i > capSample - lookback; i--) {
    let sum = 0;
    const start = Math.max(0, i - win);
    for (let j = start; j < i; j++) sum += audio[j] * audio[j];
    if (Math.sqrt(sum / (i - start)) < SILENCE_RMS) { cut = i; break; }
  }
  onTrim?.({ fromSec: durSec, toSec: cut / sampleRate });
  return audio.subarray(0, cut);
}
