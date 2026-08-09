// Partial-aware endpoint holds (smart endpointing).
//
// Silero VAD fires speech-end after ~300ms of silence (vad-stream.ts) —
// right for a finished sentence, brutal for natural mid-thought pauses: a
// breath between clauses chops one thought into separate agent turns, and
// the reply to the first half gets barged over by the second half.
//
// Instead of one fixed silence window, the in-process session holds the
// utterance commit for extra time chosen from what the live streaming
// partial looks like when the VAD flags silence. Speech resuming during the
// hold cancels the commit and the SAME utterance keeps buffering.
//
//   complete   — ends like a finished sentence     → commit immediately
//   incomplete — ends mid-thought ("and", comma)   → hold long
//   neutral    — can't tell (no punctuation, most  → hold a moderate beat
//                Zipformer models emit none)

export type EndpointVerdict = "complete" | "incomplete" | "neutral";

/** Extra hold after VAD speech-end, per verdict. Total silence tolerated =
 *  VAD's minSilenceDuration (~300ms) + this. */
export const ENDPOINT_HOLD_MS: Record<EndpointVerdict, number> = {
  complete: 0,      // ~300ms total — finished sentences commit fast
  neutral: 450,     // ~750ms total — breathing room for unpunctuated partials
  incomplete: 1100, // ~1400ms total — clearly mid-thought, let them finish
};

// Trailing words that almost never end a spoken thought. Lowercase; matched
// against the final token of the partial. Deliberately conservative — a miss
// costs one moderate hold, a false positive costs 650ms of extra wait.
const CONTINUATION_TAIL = new Set([
  "and", "but", "or", "so", "because", "cause", "then", "that", "which",
  "the", "a", "an", "to", "of", "with", "for", "in", "on", "at", "about",
  "is", "are", "was", "were", "be", "been", "my", "your", "our", "their",
  "i", "i'm", "im", "it's", "its", "we're", "they're", "you're",
  "um", "uh", "er", "uhm", "like",
]);

export function classifyEndpointPartial(partial: string): EndpointVerdict {
  const text = (partial || "").trim();
  if (!text) return "neutral";
  // Terminal punctuation (with optional closing quote/paren) = done talking.
  if (/[.!?…]["')\]]*$/.test(text)) return "complete";
  // Mid-thought punctuation = more coming.
  if (/[,;:\-]$/.test(text)) return "incomplete";
  const lastWord = text.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
  if (CONTINUATION_TAIL.has(lastWord)) return "incomplete";
  return "neutral";
}
