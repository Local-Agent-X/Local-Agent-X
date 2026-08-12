// In-process Tier-4 / CPU speaker: streams reply text to the TTS engine one
// natural chunk at a time. Split out of voice-session/index.ts to keep that
// file under the size gate; behavior is unchanged.
//
// Chunking is what makes cadence sound human, because every chunk boundary is
// a synthesis seam (a tiny gap). So seams land on PUNCTUATION, never a raw
// character count:
//   - Opener: cut at the first natural clause break ("Yeah," / "Okay, so") so
//     speech leads the text ASAP; only if none shows up by ~24 chars fall back
//     to a word boundary. (The old shape passed 24 for BOTH floors, which
//     rejected "Yeah," and cut mid-phrase — the gap landed where nobody pauses.)
//   - After the opener: flush at a clause break once ≥40 chars are pending, so
//     a long sentence starts sooner (edge-tts is a network round-trip) and every
//     seam sits on a comma/colon. Mirrors the GPU sidecar speaker.

import { SENTENCE_TERMINATOR, firstChunkCut, type TurnSpeaker } from "./turn-runner.js";

interface SpeakTarget { speak(text: string): void }

const OPENER_MIN_CHARS = 24;
const CLAUSE_FLUSH_MIN_CHARS = 40;

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
        const cut = firstChunkCut(sentenceBuf, OPENER_MIN_CHARS);
        if (cut > 0) {
          const chunk = sentenceBuf.slice(0, cut).trim();
          if (chunk) { tts.speak(chunk); ttsQueued = true; firstChunkSpoken = true; }
          sentenceBuf = sentenceBuf.slice(cut);
        }
      } else {
        const clause = /[,;:]\s+/.exec(sentenceBuf);
        if (clause && clause.index + clause[0].length >= CLAUSE_FLUSH_MIN_CHARS) {
          const cutEnd = clause.index + clause[0].length;
          const chunk = sentenceBuf.slice(0, cutEnd).trim();
          sentenceBuf = sentenceBuf.slice(cutEnd);
          if (chunk) { tts.speak(chunk); ttsQueued = true; }
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
