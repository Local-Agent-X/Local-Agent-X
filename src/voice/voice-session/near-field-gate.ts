// Near-field (proximity) gate — rejects background talkers the VAD can't.
//
// Silero VAD answers "is this speech?", not "is this speech from the person at
// the mic?". A colleague talking across the room IS speech, so VAD fires, and
// the utterance gets transcribed and (worse) barges into the reply. The
// discriminator VAD lacks is LOUDNESS: the user is near-field (close, loud),
// background talkers are far-field (quieter). This gate measures utterance
// loudness and rejects anything well below the user's own recent level.
//
// Adaptive + relative so it survives any mic gain: it tracks an EMA of the
// user's accepted-utterance loudness and rejects utterances a set ratio below
// it (plus a fixed absolute floor to reject near-silence before any baseline
// exists). Pure + deterministic — unit-tested without audio hardware.

/** Loudness as normalized RMS amplitude [0,1] (int16 → /32768). */
export function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { const s = pcm[i] / 32768; sum += s * s; }
  return Math.sqrt(sum / pcm.length);
}

// Robust utterance loudness: per-20ms-frame RMS, take a high percentile so
// leading/trailing silence and the pre-roll padding don't drag the level down
// (a real near-field word is loud even in an otherwise-quiet buffer).
const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const LOUDNESS_PERCENTILE = 0.75;

export function utteranceLoudness(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  const rms: number[] = [];
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    rms.push(frameRms(pcm.subarray(i, i + FRAME_SAMPLES)));
  }
  if (rms.length === 0) return frameRms(pcm);
  rms.sort((a, b) => a - b);
  return rms[Math.min(rms.length - 1, Math.floor(rms.length * LOUDNESS_PERCENTILE))];
}

export interface NearFieldOptions {
  /** Reject anything below this normalized RMS outright (near-silence / faint
   *  room noise), before any user baseline exists. */
  absoluteFloor?: number;
  /** Reject when loudness < ratio × the user's tracked level (far-field). 0.4
   *  ≈ 8 dB below the user — normal volume swings pass, a room-away talker
   *  doesn't. */
  relativeRatio?: number;
  /** EMA weight for updating the user level from accepted utterances. */
  emaAlpha?: number;
}

export interface NearFieldGate {
  /** Full-utterance decision; updates the user level on accept. */
  accept(pcm: Int16Array): { pass: boolean; loudness: number; floor: number };
  /** Per-frame check for the barge-in confirmation path. */
  isNearFieldFrame(pcm: Int16Array): boolean;
  /** Current adaptive floor (for logging/tests). */
  floor(): number;
  readonly userLevel: number;
}

export function createNearFieldGate(opts: NearFieldOptions = {}): NearFieldGate {
  const absoluteFloor = opts.absoluteFloor ?? 0.012;
  const relativeRatio = opts.relativeRatio ?? 0.4;
  const emaAlpha = opts.emaAlpha ?? 0.2;
  let userLevel = 0;

  const floor = () => Math.max(absoluteFloor, userLevel * relativeRatio);

  return {
    accept(pcm) {
      const loudness = utteranceLoudness(pcm);
      const f = floor();
      const pass = loudness >= f;
      if (pass) userLevel = userLevel === 0 ? loudness : userLevel * (1 - emaAlpha) + loudness * emaAlpha;
      return { pass, loudness, floor: f };
    },
    isNearFieldFrame(pcm) { return frameRms(pcm) >= floor(); },
    floor,
    get userLevel() { return userLevel; },
  };
}
