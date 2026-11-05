// In-process Tier-4 / CPU speaker: streams reply text to the TTS engine. Split out
// of voice-session/index.ts.
//
// Every chunk is synthesized on its own and said like a whole sentence, so a reply goes
// to the engine a sentence at a time; only a long opening sentence is cut early, at a
// clause break (firstChunkCut), so speech still leads the text. Cutting at every comma
// made the voice read fragments (2026-11-05). Same rule as the GPU sidecar speaker.

import { SENTENCE_TERMINATOR, firstChunkCut, type TurnSpeaker } from "./turn-runner.js";

interface SpeakTarget { speak(text: string): void }

/** `getTts` is a getter because the engine is assigned after model init; the
 *  speaker is created earlier and no-ops until it's ready. */
export function createTier4Speaker(getTts: () => SpeakTarget | null | undefined): TurnSpeaker {
  let sentenceBuf = "";
  let ttsQueued = false;
  let firstChunkSpoken = false;

  return {
    reset() { sentenceBuf = ""; ttsQueued = false; firstChunkSpoken = false; },
    feed(delta) {
      const tts = getTts();
      if (!tts) return;
      sentenceBuf += delta;
      while (true) {
        const m = SENTENCE_TERMINATOR.exec(sentenceBuf);
        if (!m) break;
        const cutEnd = m.index + m[0].length;
        const sentence = sentenceBuf.slice(0, cutEnd).trim();
        sentenceBuf = sentenceBuf.slice(cutEnd);
        if (sentence) { tts.speak(sentence); ttsQueued = true; firstChunkSpoken = true; }
      }
      if (!firstChunkSpoken) {
        const cut = firstChunkCut(sentenceBuf);
        if (cut > 0) {
          const chunk = sentenceBuf.slice(0, cut).trim();
          if (chunk) { tts.speak(chunk); ttsQueued = true; firstChunkSpoken = true; }
          sentenceBuf = sentenceBuf.slice(cut);
        }
      }
    },
    flushTail() {
      const tts = getTts();
      const tail = sentenceBuf.trim();
      if (tail && tts) { tts.speak(tail); ttsQueued = true; }
      sentenceBuf = "";
    },
    hasQueued() { return ttsQueued; },
  };
}
