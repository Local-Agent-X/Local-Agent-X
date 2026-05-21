// Two coupled audio buffers used by the voice session's STT path:
//
//   - utterance buffer: filled between VAD speech-start and speech-end,
//     drained into Whisper as one contiguous Int16Array
//   - pre-roll buffer: rolling ~250ms window of mic audio kept around so
//     we can seed the utterance with the actual onset of the word. Silero
//     VAD needs ~200ms of speech to confirm onset; without the pre-roll
//     short words like "hey" get chopped off because they finish before
//     VAD declares speech-start.

// 0.25s @ 16kHz — single short words like "hey" or "yes" need to make it
// to Whisper. 0.5s was rejecting them as too short. Whisper handles brief
// audio fine; if it returns blank/bracketed annotations we filter those.
const MIN_UTTERANCE_SAMPLES = 4000;
const MAX_UTTERANCE_SAMPLES = 16000 * 22; // 22s hard cap (VAD itself cuts at 20s)
const PREROLL_SAMPLES = 4000; // 250ms @ 16kHz

export interface AudioBuffers {
  /** Start filling. Seeds the utterance buffer with whatever pre-roll
   *  we've accumulated so the actual onset of the word reaches Whisper. */
  begin(): void;
  /** Append a frame to the utterance buffer. No-op if not currently
   *  buffering, or if the cap has been hit (VAD will cut soon). */
  append(frame: Int16Array): void;
  /** Merge utterance frames into one Int16Array, reset utterance state,
   *  return the merged audio. */
  drain(): Int16Array;
  /** Push a frame into the rolling pre-roll. Caller only invokes this
   *  when NOT mid-utterance (during speech, frames go straight into
   *  the utterance buffer instead). */
  pushPreroll(frame: Int16Array): void;
  /** Currently mid-utterance. */
  readonly isBuffering: boolean;
  /** Reset both buffers (close path). */
  clear(): void;
  readonly MIN_SAMPLES: number;
}

export function createAudioBuffers(): AudioBuffers {
  const utteranceFrames: Int16Array[] = [];
  let utteranceSamples = 0;
  let buffering = false;

  const prerollFrames: Int16Array[] = [];
  let prerollSampleCount = 0;

  return {
    begin(): void {
      utteranceFrames.length = 0;
      utteranceSamples = 0;
      for (const f of prerollFrames) {
        utteranceFrames.push(f);
        utteranceSamples += f.length;
      }
      buffering = true;
    },

    append(frame: Int16Array): void {
      if (!buffering) return;
      if (utteranceSamples >= MAX_UTTERANCE_SAMPLES) return;
      utteranceFrames.push(new Int16Array(frame));
      utteranceSamples += frame.length;
    },

    drain(): Int16Array {
      const merged = new Int16Array(utteranceSamples);
      let off = 0;
      for (const f of utteranceFrames) {
        merged.set(f, off);
        off += f.length;
      }
      utteranceFrames.length = 0;
      utteranceSamples = 0;
      buffering = false;
      return merged;
    },

    pushPreroll(frame: Int16Array): void {
      prerollFrames.push(new Int16Array(frame));
      prerollSampleCount += frame.length;
      while (prerollSampleCount > PREROLL_SAMPLES && prerollFrames.length > 0) {
        prerollSampleCount -= prerollFrames[0].length;
        prerollFrames.shift();
      }
    },

    get isBuffering(): boolean { return buffering; },

    clear(): void {
      utteranceFrames.length = 0;
      utteranceSamples = 0;
      buffering = false;
      prerollFrames.length = 0;
      prerollSampleCount = 0;
    },

    MIN_SAMPLES: MIN_UTTERANCE_SAMPLES,
  };
}
