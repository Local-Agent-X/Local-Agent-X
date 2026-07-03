/**
 * Repeat-output breaker — the model emits the SAME visible answer, turn after
 * turn, going nowhere. This is the content-repetition sibling to the existing
 * loop/stall guards, and it watches the one signal none of them do:
 *
 *   - loop-detection keys on tool-call IDENTITY (a model that varies its args —
 *     e.g. Grok reissuing slightly-different tool_search queries — slips past it,
 *     and it bails entirely on tool-less turns).
 *   - mid-turn-stale keys on EVIDENCE-COUNT staleness (tool calls that produce
 *     results read as progress, so a text loop that still calls a tool looks
 *     "productive").
 *   - repeat-failure keys on same-tool same-ERROR.
 *
 * When a model repeats its OUTPUT — identical or near-identical assistant text —
 * across turns, all of those stay silent. Observed live: a grok-4.3 chat spun
 * out ~15 identical replies and nothing broke it; only the user's stop button
 * did. This closes that hole.
 *
 * Compares each turn's normalized text against the last few (a small ring, so it
 * catches A,A,A AND short-period A,B,A,B alternation) by token-set similarity.
 * Two strikes: NUDGE once, then ABORT if it keeps repeating. Unlike loop-
 * detection — which stays nudge-only on interactive because a repeated tool CALL
 * can be legitimately user-wanted — repeated identical PROSE has no legitimate
 * form, so the abort fires on every lane. Short turns are ignored (a repeated
 * "ok"/"done" is not a runaway worth killing a turn over). Per-op state, cleared
 * on op-terminal like its siblings.
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";

const RING = 4;            // how many recent outputs to compare against
const NUDGE_AT = 2;        // consecutive repeats before the warning
const ABORT_AT = 4;        // consecutive repeats before the hard stop
const MIN_TOKENS = 8;      // ignore short acks — too little signal, not a runaway
const SIMILAR_THRESHOLD = 0.9;

/** Lowercase, strip to alphanumeric tokens — so trivial punctuation/markdown
 *  churn doesn't hide a repeat. Exported for testing. */
export function normalizeForRepeat(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Token-set Jaccard ≥ threshold. Near-identical prose scores ~1.0; two
 *  genuinely different answers score well below. Exported for testing. */
export function outputsSimilar(a: string[], b: string[], threshold = SIMILAR_THRESHOLD): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union >= threshold;
}

interface RepeatState {
  recent: string[][]; // normalized token lists of the last RING substantive turns
  repeats: number;    // consecutive turns whose output matched something recent
  nudged: boolean;
}

export const repeatOutputMiddleware: CanonicalMiddleware = {
  name: "repeat-output",

  afterModelCall(ctx) {
    const tokens = normalizeForRepeat(ctx.assistantContent);
    if (tokens.length < MIN_TOKENS) return { kind: "continue" };

    const state = getMiddlewareState<RepeatState>(
      ctx.op.id,
      "repeat-output",
      () => ({ recent: [], repeats: 0, nudged: false }),
    );

    const matched = state.recent.some((prev) => outputsSimilar(tokens, prev));
    state.repeats = matched ? state.repeats + 1 : 0;
    state.recent.push(tokens);
    if (state.recent.length > RING) state.recent.shift();

    if (state.repeats >= ABORT_AT) {
      const msg =
        `Halting: the same response has been produced ${state.repeats + 1} times in a row ` +
        `with no progress — a stuck loop. Ending the turn.`;
      ctx.onEvent?.({ type: "stream", delta: msg });
      return { kind: "abort", reason: "repeat-output", message: msg };
    }

    if (state.repeats >= NUDGE_AT && !state.nudged) {
      state.nudged = true;
      return {
        kind: "nudge",
        reason: "repeat-output",
        message:
          `You've produced essentially the same response ${state.repeats + 1} times in a row. ` +
          `Repeating it again will not help. Do something different: take a concrete tool action ` +
          `that changes state, give a genuinely new answer, or end the turn. Do not restate this.`,
      };
    }

    return { kind: "continue" };
  },
};
