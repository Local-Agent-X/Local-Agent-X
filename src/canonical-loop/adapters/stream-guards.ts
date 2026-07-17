/**
 * Degenerate-output stream guard — incremental loop/garble detection over a
 * LIVE local-model stream.
 *
 * Motivation: a local model can degenerate mid-stream (observed: a local
 * Gemma looping the same sentence verbatim for 41 seconds until the user hit
 * abort). The max_tokens guard rail (openai-http.ts) bounds the damage; this
 * guard cuts it within seconds. Sibling in spirit to context-manager/
 * llm-rewrite-guard.ts's detectDegenerateRewrite, which screens a COMPLETED
 * rewrite post-hoc — this one watches the tail of an in-flight stream so the
 * caller can abort early. (Deliberately a separate implementation: the
 * rewrite guard's whole-text duplicate-line / gzip signals don't apply
 * incrementally.)
 *
 * Only ever armed for LOCAL endpoints (see stream-once.ts), and deliberately
 * conservative: legit prose, code, JSON, markdown tables, and non-Latin
 * scripts (CJK counts as letters via \p{L}) must never trip it. A missed
 * loop is bounded by max_tokens; a false trip kills a healthy answer — so
 * every detector carries an extra quality gate beyond its headline ratio.
 *
 * Detectors, run every ~checkEveryChars over the last ~tailWindowChars:
 *  (a) tail repetition — a trailing block of ≥ minRepeatBlockChars occurring
 *      ≥ minRepeatCount times consecutively at the stream tail. Qualified:
 *      the repeating block must contain a letter and ≥ 8 distinct chars, so
 *      legit low-alphabet repetition (`0, 0, 0, …` arrays, `null,` dumps)
 *      never counts as a loop.
 *  (b) garble — on ≥ 80 whitespace-compacted chars: letter+digit ratio
 *      < 0.08 AND symbol ratio > 0.6 (symbol soup), OR a single char both
 *      dominating (> 0.4 of the window) and running ≥ 80 consecutive chars
 *      in the RAW stream — whitespace breaks a run, so a space/newline-
 *      separated numeric matrix (`0 0 0 …`) is data, while `!!!!…` /
 *      `aaaa…` floods trip. The run requirement is the safety valve for
 *      legit structure-heavy text: a skinny markdown table is pipe-
 *      DOMINATED but its pipes never run consecutively.
 */

/** User-facing one-liner for the `stopped` notice when the guard trips. */
export const DEGENERATE_STREAM_STOP_REASON =
  "Local model output degenerated — stream stopped early";

export interface DegenerateStreamGuardOptions {
  /** Run the detectors every N accumulated chars. Default 512. */
  checkEveryChars?: number;
  /** Tail window (chars) the detectors examine. Default 2000. */
  tailWindowChars?: number;
  /** Smallest trailing block that can count as a repetition loop. Default 80. */
  minRepeatBlockChars?: number;
  /** Consecutive occurrences of that block that count as looping. Default 3. */
  minRepeatCount?: number;
}

export type StreamGuardVerdict = { tripped: false } | { tripped: true; reason: string };

export interface DegenerateStreamGuard {
  /** Feed one stream delta; returns the (sticky) verdict. */
  feed(delta: string): StreamGuardVerdict;
}

const DEFAULT_CHECK_EVERY_CHARS = 512;
const DEFAULT_TAIL_WINDOW_CHARS = 2000;
const DEFAULT_MIN_REPEAT_BLOCK_CHARS = 80;
const DEFAULT_MIN_REPEAT_COUNT = 3;

// Repetition quality gate: the repeating block must look like language, not
// like data. A looped sentence easily clears both bars; `0, ` / `null, `
// units don't.
const REPEAT_BLOCK_MIN_DISTINCT_CHARS = 8;

// Garble thresholds (fixed — the shape of "not text at all" doesn't vary by
// call site the way window/cadence do).
const GARBLE_MIN_COMPACT_CHARS = 80;
const GARBLE_LETTER_DIGIT_FLOOR = 0.08;
const GARBLE_SYMBOL_CEIL = 0.6;
const DOMINANCE_RATIO = 0.4;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const HAS_LETTER = /\p{L}/u;

/**
 * Trailing-repetition detector. Returns a human-readable detail string when
 * the tail ends in ≥ minCount consecutive copies of the same ≥ minBlock-char
 * block, null otherwise. Scans every candidate period p (any p that is a
 * multiple of the true loop period matches, so short loops are covered by
 * blocks ≥ minBlock), with a cheap last-char prefilter before comparing.
 */
function findTailRepetition(
  tail: string,
  minBlock: number,
  minCount: number,
): string | null {
  const n = tail.length;
  if (n < minBlock * minCount) return null;
  const last = tail.charCodeAt(n - 1);
  const maxPeriod = Math.floor(n / minCount);
  for (let p = minBlock; p <= maxPeriod; p++) {
    if (tail.charCodeAt(n - 1 - p) !== last) continue;
    const block = tail.slice(n - p);
    let count = 1;
    while (count < minCount && tail.startsWith(block, n - (count + 1) * p)) count++;
    if (count < minCount) continue;
    // Quality gate — see file header: repetition of low-alphabet data
    // (numeric arrays, `null,` dumps) is normal output, not a loop.
    if (!HAS_LETTER.test(block) || new Set(block).size < REPEAT_BLOCK_MIN_DISTINCT_CHARS) continue;
    return `tail repetition: trailing ${p}-char block repeated ${count}x consecutively`;
  }
  return null;
}

const WHITESPACE = /\s/u;

/**
 * Garble detector. RATIOS are measured over the whitespace-compacted view
 * (prose spacing must not dilute a symbol flood), but run CONTIGUITY is
 * measured on the RAW text: whitespace breaks a run. Compacting before the
 * run scan manufactured a phantom 240-char "run" of `0` out of a
 * space/newline-separated zero matrix — legitimate data, not degeneration.
 * Iterates code points (`for..of`), so astral-plane scripts count correctly.
 */
function findGarble(tail: string): string | null {
  let total = 0;
  let letterDigit = 0;
  let maxRun = 0;
  let maxRunChar = "";
  let run = 0;
  let prev = "";
  const counts = new Map<string, number>();
  for (const ch of tail) {
    if (WHITESPACE.test(ch)) {
      run = 0;
      prev = "";
      continue;
    }
    total++;
    if (LETTER_OR_DIGIT.test(ch)) letterDigit++;
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > maxRun) {
      maxRun = run;
      maxRunChar = ch;
    }
  }
  if (total < GARBLE_MIN_COMPACT_CHARS) return null;

  const letterDigitRatio = letterDigit / total;
  const symbolRatio = (total - letterDigit) / total;
  if (letterDigitRatio < GARBLE_LETTER_DIGIT_FLOOR && symbolRatio > GARBLE_SYMBOL_CEIL) {
    return `garble: letters+digits ${(letterDigitRatio * 100).toFixed(1)}% / symbols ${(symbolRatio * 100).toFixed(1)}% over last ${total} non-space chars`;
  }

  const runCharCount = maxRunChar === "" ? 0 : (counts.get(maxRunChar) ?? 0);
  if (maxRun >= GARBLE_MIN_COMPACT_CHARS && runCharCount / total > DOMINANCE_RATIO) {
    return `garble: single char ${JSON.stringify(maxRunChar)} is ${((runCharCount / total) * 100).toFixed(1)}% of the last ${total} non-space chars (longest run ${maxRun})`;
  }
  return null;
}

/**
 * Create a degenerate-stream guard. Feed every text delta; the verdict is
 * sticky once tripped. Detector work only runs at ~checkEveryChars
 * boundaries, so per-delta cost between checks is a string append.
 */
export function createDegenerateStreamGuard(
  opts: DegenerateStreamGuardOptions = {},
): DegenerateStreamGuard {
  const checkEvery = opts.checkEveryChars ?? DEFAULT_CHECK_EVERY_CHARS;
  const window = opts.tailWindowChars ?? DEFAULT_TAIL_WINDOW_CHARS;
  const minBlock = opts.minRepeatBlockChars ?? DEFAULT_MIN_REPEAT_BLOCK_CHARS;
  const minCount = opts.minRepeatCount ?? DEFAULT_MIN_REPEAT_COUNT;

  let tail = "";
  let sinceCheck = 0;
  let tripped: StreamGuardVerdict = { tripped: false };

  return {
    feed(delta: string): StreamGuardVerdict {
      if (tripped.tripped) return tripped;
      if (delta.length > 0) {
        tail = tail.length + delta.length > window ? (tail + delta).slice(-window) : tail + delta;
        sinceCheck += delta.length;
      }
      if (sinceCheck < checkEvery) return tripped;
      sinceCheck = 0;
      const detail = findTailRepetition(tail, minBlock, minCount) ?? findGarble(tail);
      if (detail !== null) tripped = { tripped: true, reason: detail };
      return tripped;
    },
  };
}
