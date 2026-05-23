// Memory-curate boost detection. Runs in two stages:
//   1. Cheap regex/CorrectionLearner — catches obvious phrasings ("always",
//      "never", "I prefer", explicit "no/wrong" corrections). If any of
//      these match, boost immediately and skip the LLM call.
//   2. LLM classifier (Haiku 4.5, ~$0.0004/call, 2s timeout) — catches
//      natural-language teaching moments the regex misses ("you need to
//      toggle to instagram view", "switch to the other dropdown", etc.).
//      Only runs when regex didn't fire. On any failure (no auth, timeout,
//      bad JSON) silently falls back to "no boost from classifier" and
//      lets the cadence-based fire catch it eventually.
//
// In-prompt nudge is DISABLED — it competed with task completion in
// the live model's attention and produced regressions (turn ending
// with neither a useful answer NOR a memory write). Memory writes
// now happen via the end-of-turn pass in routes/chat.ts which runs
// AFTER the user has already received the assistant's reply, with
// no attention split.
//
// The classifier + boost calls still run because:
//   (a) the boost log lines are useful diagnostic signal during
//       calibration ("did the classifier even fire on this turn?")
//   (b) the per-session counter is read by the end-of-turn pass to
//       decide whether to invoke its (cheaper) decision call
//
// To re-enable in-prompt nudges (e.g. for A/B comparison), set
// env LAX_MEMORY_INPROMPT_NUDGE=1.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-request.prepare-request.curate");

export interface CurateNudgeInput {
  message: string;
  sessionMessages: ChatCompletionMessageParam[];
  sessionId: string;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedApiKey: string;
}

/** Returns the in-prompt curate block (usually empty unless
 *  LAX_MEMORY_INPROMPT_NUDGE=1 is set). Always runs the boost detection
 *  side-effects regardless of the env flag — see file header for why. */
export async function detectAndBoostCurate(input: CurateNudgeInput): Promise<string> {
  let memoryCurateBlock = "";
  try {
    const { checkAndConsumeNudge, boostNudgePriority } = await import("../../memory/curate-nudge.js");
    let regexBoosted = false;
    // Stage 1 — CorrectionLearner regex (still used as a signal source even
    // though its verbatim output no longer gets injected into prompts).
    const lastAssistantMsg = [...input.sessionMessages].reverse().find(m => m.role === "assistant");
    const lastAssistantText = typeof lastAssistantMsg?.content === "string" ? lastAssistantMsg.content : "";
    try {
      const { CorrectionLearner } = await import("../../correction-learning.js");
      if (lastAssistantText) {
        const correction = CorrectionLearner.getInstance().detectCorrection(input.message, lastAssistantText);
        if (correction) { boostNudgePriority(input.sessionId, "correction-detected"); regexBoosted = true; }
      }
    } catch { /* detector unavailable — fine */ }
    // Stage 1 cont. — preference-phrase regex
    if (/\b(always|never|next time|from now on|i prefer|i like to|i usually|please remember|don['']?t forget|going forward|in the future)\b/i.test(input.message)) {
      boostNudgePriority(input.sessionId, "preference-stated");
      regexBoosted = true;
    }
    if (/\b(remember (this|that)|save this|note this|keep in mind that)\b/i.test(input.message)) {
      boostNudgePriority(input.sessionId, "explicit-remember");
      regexBoosted = true;
    }
    // Stage 2 — LLM classifier as second-opinion when regex missed. Run
    // in the background AT LOW PRIORITY so we don't block the user turn:
    // we await with a short overall budget; if the classifier is slow,
    // we skip the boost and let cadence catch it next time. The boost
    // (if it lands in time) still affects THIS turn's nudge check.
    if (!regexBoosted) {
      try {
        const { classifyTeachMoment } = await import("../../memory/curate-classifier.js");
        // Use the SAME provider+model+apiKey the chat is on — the classifier
        // calls the same client functions the main agent uses, so CLI OAuth
        // (Anthropic) and subscription bearer (Codex) auth "just work" with
        // no per-provider auth abstraction needed. Cost-bounded by the tiny
        // ~30-token output and 2s timeout. xAI/Gemini fall through to null
        // (regex+cadence still work for those providers).
        const classification = await classifyTeachMoment(input.message, lastAssistantText, {
          providerHint: input.resolvedProvider,
          modelHint: input.resolvedModel,
          apiKey: input.resolvedApiKey,
        });
        if (classification && classification.teach && classification.confidence >= 0.6 && classification.kind !== "none") {
          boostNudgePriority(input.sessionId, classification.kind);
          logger.info(`[chat] curate-classifier boosted ${classification.kind} (conf=${classification.confidence.toFixed(2)}, why=${classification.why}, provider=${input.resolvedProvider}) sess=${input.sessionId}`);
        }
      } catch { /* classifier unavailable — fall back to cadence */ }
    }
    if (process.env.LAX_MEMORY_INPROMPT_NUDGE === "1") {
      const nudge = checkAndConsumeNudge(input.sessionId);
      if (nudge) {
        memoryCurateBlock = `\n\n${nudge}\n`;
        logger.info(`[chat] injecting memory-curate nudge for sess=${input.sessionId}`);
      }
    }
  } catch { /* best-effort */ }
  return memoryCurateBlock;
}
