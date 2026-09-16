/**
 * How the harness reports its OWN failure to the model.
 *
 * A tool's domain errors are written for the model — "File not found", "HTTP
 * 404", each with a recovery line the renderer surfaces. The harness's internal
 * failures were not: the dispatcher minted `result: { error: "<exception
 * message>" }`, so an internal exception reached the model as bare jargon with
 * no next action. On 2026-09-16 a browser click came back as `{"error":
 * "side-effect journal claim lost"}` — a sentence about a journal claim, which
 * the model can do exactly nothing with — and it retried the same click ten
 * times.
 *
 * Every failure the model reads has to answer two questions: what went wrong,
 * and what should I do now. This mints that shape for the internal ones, using
 * the same envelope + renderer the tools use, so they arrive looking like every
 * other failure the model already knows how to read.
 */
import { err } from "../tools/result-helpers.js";
import { renderToolResultForModel } from "../tools/result-helpers.js";

/** The default when the harness has no better idea than "this was ours". */
const GENERIC_RECOVERY =
  "This is a harness-side failure, not something wrong with your arguments. " +
  "Retrying the identical call is unlikely to help — do the step a different way, " +
  "or tell the user plainly what could not be completed.";

/**
 * Render an internal failure as the model-facing string the tool envelope
 * produces, with a recovery line it can act on.
 */
export function internalToolFailureText(what: string, recovery: string = GENERIC_RECOVERY): string {
  return renderToolResultForModel(err(what, { recovery, internal: true }));
}
