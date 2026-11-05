// Whisper noise-annotation hygiene — ONE source of truth for scrubbing the
// stage directions Whisper hallucinates on quiet/cut-off audio before they
// reach the agent or the dictation textarea as if the user said them.
//
// Two shapes exist in the wild:
//   • bracketed: "[BLANK_AUDIO]", "[music]" — stripped ANYWHERE in the text
//     (they can ride alongside real words), including an unclosed trailing
//     "[..." span.
//   • parenthesized / asterisked: "(muffled speaking", "(inaudible)",
//     "*sighs*" — treated as noise only when they are the ENTIRE final, so a
//     legitimate spoken aside ("call John (my brother) tomorrow") survives.
//     Whisper's unclosed variants ("(muffled speaking") count too — that
//     exact form reached the agent as user speech and got a "didn't catch
//     that" reply.
//
// Callers: voice-session turn machine (live voice + dictate), continuous-listen's
// stt.ts and transcribe-media. Extend HERE, not with a second regex.

/** Scrub Whisper noise annotations. Returns "" when nothing real remains —
 *  callers drop the final entirely in that case. */
export function stripTranscriptNoise(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  // Whole-final stage direction in parens or asterisks, closed or unclosed.
  if (/^\([^)]*\)?[.…]?$/s.test(trimmed)) return "";
  if (/^\*[^*]*\*?[.…]?$/s.test(trimmed)) return "";
  // Bracketed annotations anywhere; second pass clears an unclosed trailing
  // "[..." so stray bracketed text can't survive (or mimic system notices).
  return trimmed.replace(/\[[^\]]*\]/gs, "").replace(/\[[^\]]*$/s, "").trim();
}

// Whisper's decoder can loop, writing a sentence or phrase again and again: the
// phone's recognizer turned one "Well, we can practice more in a few questions."
// into three (2026-11-05), and the agent answered all three. Nobody says the same
// sentence of four words or more twice in a row, or any phrase three times, so a
// repeat that long is the decoder, not the speaker. Short repeats a person does say
// ("No. No.", "very very") are kept. Live speech only: a media transcript can repeat
// on purpose (a chorus), so transcribe-media does not call this.

/** Words of a sentence, lowercased, without punctuation, for comparing. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
}

const sameWords = (a: string[], b: string[]): boolean => a.length === b.length && a.every((w, i) => w === b[i]);

/** Scripts written without spaces between words, where a word count says nothing. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;

/** Long enough that saying it twice in a row is the decoder: four words, or eight
 *  characters of a script written without spaces. */
function isLongSentence(sentence: string, words: string[]): boolean {
  return words.length >= 4 || (sentence.match(UNSPACED)?.length ?? 0) >= 8;
}

/** Drop a sentence that repeats the one before it: always when it is long
 *  (isLongSentence), and from the third time for shorter ones. */
function collapseRepeatedSentences(text: string): string {
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/gu) ?? [text];
  const kept: string[] = [];
  let run = 0;
  for (const sentence of sentences) {
    const prev = kept[kept.length - 1];
    const words = wordsOf(sentence);
    const repeat = prev !== undefined && words.length > 0 && sameWords(words, wordsOf(prev));
    run = repeat ? run + 1 : 0;
    if (repeat && (isLongSentence(sentence, words) || run >= 2)) continue;
    kept.push(sentence);
  }
  return kept.join("").trim();
}

/** Collapse a run of the same 3-to-12-word phrase said three times or more in a row,
 *  with or without punctuation between, to one. */
function collapseRepeatedPhrases(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const norm = tokens.map((t) => wordsOf(t).join(" "));
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let skipped = false;
    for (let k = 12; k >= 3 && !skipped; k--) {
      if (i + k * 3 > tokens.length) continue;
      const phrase = norm.slice(i, i + k);
      let reps = 1;
      while (i + (reps + 1) * k <= tokens.length && sameWords(norm.slice(i + reps * k, i + (reps + 1) * k), phrase)) reps++;
      if (reps >= 3) {
        out.push(...tokens.slice(i, i + k));
        i += reps * k;
        skipped = true;
      }
    }
    if (!skipped) out.push(tokens[i++]!);
  }
  return out.join(" ");
}

/** A live utterance with the decoder's repeats taken out (see above). */
export function collapseLoopedRepeats(text: string): string {
  return collapseRepeatedPhrases(collapseRepeatedSentences(text));
}
