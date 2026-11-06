// Cuts a streamed reply into the pieces a TTS engine speaks, for both speakers (the
// in-process one in tier4-speaker.ts and the GPU sidecar's in gpu-session.ts).
//
// Every piece is synthesized on its own and said like a whole sentence: it ends on a
// falling tone and a pause. Cutting at every comma made every voice sound like a machine
// reading fragments (2026-11-05), so the reply goes out a sentence at a time. Only the
// opening may be cut early, so the voice does not trail the text: when the stream goes
// quiet for OPENER_WAIT_MS before the first sentence ends, what has arrived is spoken up
// to its last clause break (where a person pauses anyway), else its last word boundary.
// A timer, not the next delta, decides: a reply that says "Let me check" and then runs a
// tool streams nothing more until the tool returns, and waiting for text held its first
// words back 2.4 s. The timer restarts on every delta, so a stream that is still flowing
// is never cut: timed from the first words, it cut "Appreciate you" off "too, Peter."
//
// A piece cut early always ends in a clause mark. A cloned voice (VoxCPM) given a line
// with no ending makes one up: "Appreciate you" came out "Appreciate you dot"
// (2026-11-05). With a comma it ends the piece as the pause it is.

import { SENTENCE_TERMINATOR } from "./turn-runner.js";

/** How long the stream may go quiet inside the opening sentence before part of it is spoken. */
export const OPENER_WAIT_MS = 250;

/** Where to cut an unfinished opening: after its last clause break (the buffer's end
 *  counts), else its last word boundary; -1 when there is neither. */
export function openerCut(buf: string): number {
  let clauseEnd = -1;
  for (const m of buf.matchAll(/[,;:](?:\s+|$)/g)) clauseEnd = m.index + m[0].length;
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
    const piece = buf.slice(0, cut).trim();
    say(/[,;:]$/.test(piece) ? piece : `${piece},`);
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
      if (openerDone || buf.trim() === "") return;
      stopTimer();
      openerTimer = timers.set(cutOpener, OPENER_WAIT_MS);
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
