// In-process Tier-4 / CPU speaker: streams reply text to the TTS engine. Split out
// of voice-session/index.ts.
//
// The reply goes to the engine a sentence at a time (sentence-chunker.ts), the same
// pieces the GPU sidecar speaker sends.

import { type TurnSpeaker } from "./turn-runner.js";
import { createSentenceChunker } from "./sentence-chunker.js";

interface SpeakTarget { speak(text: string): void }

/** `getTts` is a getter because the engine is assigned after model init; the
 *  speaker is created earlier and no-ops until it's ready. */
export function createTier4Speaker(getTts: () => SpeakTarget | null | undefined): TurnSpeaker {
  let ttsQueued = false;
  const chunker = createSentenceChunker((text) => {
    const tts = getTts();
    if (!tts) return;
    tts.speak(text);
    ttsQueued = true;
  });
  return {
    reset() { chunker.reset(); ttsQueued = false; },
    feed(delta) { if (getTts()) chunker.feed(delta); },
    flushTail: () => chunker.flushTail(),
    hasQueued() { return ttsQueued; },
  };
}
