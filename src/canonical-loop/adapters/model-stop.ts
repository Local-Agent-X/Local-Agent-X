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

export const MODEL_REFUSAL_CODE = "model_refusal";

/**
 * A stop the provider uses to say it declined to answer: Anthropic `refusal`,
 * OpenAI-compat `content_filter`. The stream carries no text for it, so
 * without this the turn ended "clean" with nothing to show — the user saw a
 * thinking step and then silence (2026-09-28, four times in one evening).
 * Reported as a non-retryable error, it reaches the chat as the same error
 * boundary any other terminal failure uses.
 */
export function refusalError(stop: string | undefined | null): { code: string; message: string } | null {
  if (!stop) return null;
  const s = stop.toLowerCase();
  if (s !== "refusal" && s !== "content_filter") return null;
  return {
    code: MODEL_REFUSAL_CODE,
    message: `The model declined this request under its content policy (stop reason "${stop}"); nothing ran. Rephrase the request, or pick another model.`,
  };
}

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
