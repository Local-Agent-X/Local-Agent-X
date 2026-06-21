/**
 * Normalize a provider stop_reason / finish_reason string into the canonical
 * loop's continue-vs-stop signal.
 *
 * This is deliberately narrow and distinct from `../../response-classifier.ts`
 * (which produces a rich retry/fallback verdict for the HTTP path). The only
 * question this answers is the one `turn-loop/decide-outcome.ts` needs: did the
 * model DECLARE this turn finished, or does it want to keep going?
 *
 *   - "ended"    → the model said it's done (Anthropic `end_turn`, OpenAI
 *                  `stop`, `stop_sequence`). decide-outcome trusts this to
 *                  terminate the turn in ONE pass — including a non-silent tool
 *                  turn — instead of inferring a wrap-up from tool shape.
 *   - "continue" → the model paused for more (`tool_use` / `tool_calls`) or was
 *                  cut off (`max_tokens` / `length`) / filtered — NOT a clean
 *                  completion, so decide-outcome must NOT force "done" off it.
 *   - undefined  → the path/turn carried no usable stop reason; decide-outcome
 *                  falls back entirely to its shape heuristics.
 *
 * Mapping anything that isn't an explicit end-of-turn to "continue" is the safe
 * default: for the done-decision, "continue" and `undefined` behave identically
 * (neither forces "done"), so an unrecognized stop string can never short a
 * turn that the shape heuristics would have kept alive.
 */
export type ModelStop = "ended" | "continue";

export function classifyModelStop(stop: string | undefined | null): ModelStop | undefined {
  if (!stop) return undefined;
  switch (stop.toLowerCase()) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "ended";
    default:
      // tool_use / tool_calls (wants the tool result), max_tokens / length
      // (truncated mid-thought), content_filter / refusal / abort / error, and
      // any provider-specific value we don't recognize.
      return "continue";
  }
}
