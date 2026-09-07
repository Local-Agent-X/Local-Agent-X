/**
 * Assertion-repeat detector — stagnation measured from what the agent SAYS,
 * not from the shape of its tool calls.
 *
 * Every other loop signal in this repo keys on tool patterns: same call, same
 * procedure, same search, no mutation. All of them can be evaded by an agent
 * that keeps varying its calls while learning nothing — and one did, for 110
 * turns of a recorded 160-turn op. What that run could not hide was its own
 * prose: it wrote "Both fixes are live on prod" EIGHT separate times, each
 * after re-fetching the same two unchanged URLs.
 *
 * A restated conclusion is a higher-precision stagnation signal than any tool
 * pattern, because it is direct evidence rather than a proxy: tool repetition
 * only suggests the agent might not be learning, whereas re-asserting a fact
 * it already established proves it. It is also nearly free — the text is
 * already in the turn context.
 *
 * SCOPE, deliberately narrow. Only sentences that ASSERT something about the
 * world are counted. Narration ("Let me check the CSS"), questions, and short
 * fragments are skipped, because repeating those is normal and useful. The
 * detector nudges; it never aborts a turn. Being wrong costs one sentence of
 * context, and the ceiling below bounds even that.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";

/** Times one assertion may be restated before it is a stagnation signal. Three,
 *  because a second mention is often a legitimate recap of a just-proved fact;
 *  a third is the agent telling itself the same thing again. */
const REPEAT_LIMIT = 3;
/** Lifetime nudges per op, so a model that ignores this cannot be spammed. */
const NUDGE_CEILING = 2;
/** Below this length a "sentence" is a fragment, not a claim. */
const MIN_ASSERTION_CHARS = 24;
/** Bound on remembered assertions per op. */
const MAX_TRACKED = 200;

/** Openers that mark narration or intent rather than a claim about state.
 *  Repeating "let me check X" is how an agent works; repeating "X is true" is
 *  how it stalls. */
const NARRATION_OPENERS = [
  "let me", "let's", "i'll", "i will", "i am going", "i'm going", "now i",
  "next", "first", "then", "checking", "looking", "trying", "verifying",
  "running", "one moment", "okay", "ok,", "alright",
];

interface AssertionState {
  counts: Map<string, { count: number; text: string }>;
  nudges: number;
}

const KEY = "assertion-repeat";

function createAssertionState(): AssertionState {
  return { counts: new Map(), nudges: 0 };
}

/** Collapse the parts of a sentence that vary between restatements of the same
 *  claim — numbers, quoted values, paths, and inline code spans. "Both fixes
 *  are live on prod (20359 bytes)" and "Both fixes are live on prod (20361
 *  bytes)" are the same assertion. */
export function normalizeAssertion(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/`[^`]*`/g, "<code>")
    .replace(/["'][^"']*["']/g, "<q>")
    .replace(/(?:[\w.-]*[\\/])+[\w.-]+/g, "<path>")
    .replace(/\d[\d,._]*/g, "<n>")
    .replace(/[^a-z<>\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences from a turn's visible text that assert something about state. */
export function extractAssertions(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < MIN_ASSERTION_CHARS) continue;
    if (sentence.endsWith("?")) continue;              // a question is not a claim
    if (sentence.startsWith("#") || sentence.startsWith("|")) continue; // headings, tables
    const lower = sentence.toLowerCase();
    if (NARRATION_OPENERS.some(o => lower.startsWith(o))) continue;
    out.push(sentence);
  }
  return out;
}

function nudgeFor(text: string, count: number): string {
  return [
    `SYSTEM: you have now stated this ${count} times in this task:`,
    `  "${text.length > 200 ? `${text.slice(0, 200)}…` : text}"`,
    `Re-establishing something you already established is not progress, and repeating it will not make it more true. Either act on it, test something that could disprove it, or tell the user what you have concluded and what you still cannot determine.`,
  ].join("\n");
}

export const assertionRepeatMiddleware: CanonicalMiddleware = {
  name: "assertion-repeat",

  afterModelCall(ctx) {
    const state = getMiddlewareState<AssertionState>(ctx.op.id, KEY, createAssertionState);
    if (state.nudges >= NUDGE_CEILING) return { kind: "continue" };

    let worst: { text: string; count: number } | null = null;
    // Dedupe within the turn first: a single message that repeats one line
    // twice is a formatting artifact, not a restatement across turns.
    const seenThisTurn = new Set<string>();
    for (const sentence of extractAssertions(ctx.assistantContent)) {
      const key = normalizeAssertion(sentence);
      if (!key || seenThisTurn.has(key)) continue;
      seenThisTurn.add(key);
      const entry = state.counts.get(key);
      if (!entry) {
        if (state.counts.size < MAX_TRACKED) state.counts.set(key, { count: 1, text: sentence });
        continue;
      }
      entry.count += 1;
      if (entry.count >= REPEAT_LIMIT && (!worst || entry.count > worst.count)) {
        worst = { text: entry.text, count: entry.count };
      }
    }

    if (!worst) return { kind: "continue" };
    state.nudges += 1;
    // Reset so the same assertion must re-accumulate before nudging again.
    state.counts.set(normalizeAssertion(worst.text), { count: 0, text: worst.text });
    return { kind: "nudge", message: nudgeFor(worst.text, worst.count), reason: "assertion-repeat" };
  },
};
