// Cuts a streamed reply into the pieces a TTS engine speaks, for both speakers (the
// in-process one in tier4-speaker.ts and the GPU sidecar's in gpu-session.ts).
//
// Every piece is synthesized on its own and said like a whole sentence: it ends on a
// falling tone and a pause. Cutting at every comma made every voice sound like a machine
// reading fragments (2026-11-05), so the reply goes out a sentence at a time. Only the
// opening may be cut early, so the voice does not trail the text: when its first
// sentence has not ended OPENER_WAIT_MS after the reply's first words, what has arrived
// is spoken up to its last clause break (where a person pauses anyway), else its last
// word boundary. A timer, not the next delta, decides: a reply that says "Let me check"
// and then runs a tool streams nothing more until the tool returns, and waiting for
// text held its first words back 2.4 s.

import { SENTENCE_TERMINATOR } from "./turn-runner.js";

/** How long the opening sentence may take to finish before part of it is spoken. */
export const OPENER_WAIT_MS = 250;

/** Where to cut an unfinished opening: after its last clause break, else its last word
 *  boundary; -1 when there is neither. */
export function openerCut(buf: string): number {
  let clauseEnd = -1;
  for (const m of buf.matchAll(/[,;:]\s+/g)) clauseEnd = m.index + m[0].length;
  if (clauseEnd > 0) return clauseEnd;
  const space = buf.lastIndexOf(" ");
  return space > 0 ? space + 1 : -1;
}

export interface SentenceChunker {
  /** Append a streamed delta; speak every sentence it completes. */
  feed(delta: string): void;
  /** The reply is over: speak what is left. */
  flushTail(): void;
  /** A new reply (or a barge-in): drop what is buffered. */
  reset(): void;
}

export function createSentenceChunker(
  speak: (text: string) => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): SentenceChunker {
  let buf = "";
  let openerDone = false;
  let openerTimer: unknown = null;

  const stopTimer = (): void => {
    if (openerTimer !== null) timers.clear(openerTimer);
    openerTimer = null;
  };
  const say = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    openerDone = true;
    stopTimer();
    speak(t);
  };
  const cutOpener = (): void => {
    openerTimer = null;
    if (openerDone) return;
    const cut = openerCut(buf);
    if (cut <= 0) return;
    say(buf.slice(0, cut));
    buf = buf.slice(cut);
  };

  return {
    feed(delta) {
      buf += delta;
      for (let m = SENTENCE_TERMINATOR.exec(buf); m; m = SENTENCE_TERMINATOR.exec(buf)) {
        const end = m.index + m[0].length;
        say(buf.slice(0, end));
        buf = buf.slice(end);
      }
      if (!openerDone && openerTimer === null && buf.trim() !== "") openerTimer = timers.set(cutOpener, OPENER_WAIT_MS);
    },
    flushTail() {
      stopTimer();
      say(buf);
      buf = "";
    },
    reset() {
      stopTimer();
      buf = "";
      openerDone = false;
    },
  };
}
