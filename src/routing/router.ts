/**
 * Router — the SINGLE owner of "should this message run inline or
 * delegate to a worker." Replaces shouldAutoDelegate from the old
 * src/workers/auto-delegate.ts.
 *
 * Architecture (per upstream/upstream consolidation pattern):
 *   - regex-rules.ts  : fast, cheap pattern matching (priority cascade)
 *   - llm-classifier.ts : second-opinion veto when regex says delegate
 *   - decision-log.ts : persistent + in-memory log for telemetry
 *   - delegate-worker.ts : actually submits the op when delegating
 *   - router.ts (this) : orchestrates them, single public entry point
 *
 * Caller uses:
 *   const decision = await routeMessage(provider, message, channel);
 *   if (decision.destination === "delegate") {
 *     const { opId, replyText } = await delegateMessageToWorker(...);
 *     linkDecisionToOpId(opId, message);
 *   }
 *
 * Adding a new routing rule = edit regex-rules.ts (only).
 * Tuning the LLM classifier = edit llm-classifier.ts (only).
 * Adding a new persisted field = edit types.ts + decision-log.ts.
 * No routing logic should exist outside src/routing/.
 */

import { createLogger } from "../logger.js";
import { decideByRegex } from "./regex-rules.js";
import { classifyRouteWithLLM } from "./llm-classifier.js";
import { recordDecision } from "./decision-log.js";
import type { RouteDecision } from "./types.js";

const logger = createLogger("routing.router");

/**
 * Decide where a chat message should run. Single entry point — every
 * caller (chat route, future tool-router, future API endpoint) calls
 * this exactly. No bypass paths.
 *
 * Process:
 *   1. Run regex rules (fast, cheap). Result is provisional.
 *   2. If regex says INLINE, trust it (return immediately, no LLM call).
 *   3. If regex says DELEGATE, call LLM classifier as second opinion.
 *      If LLM says INLINE, override (regex over-eager).
 *   4. Record the decision (in-memory + disk) for telemetry / training.
 *   5. Return final decision to caller.
 *
 * The LLM check is opt-out via env LAX_ROUTE_CLASSIFIER=0.
 */
export async function routeMessage(
  provider: string,
  message: string,
  channel: string,
): Promise<RouteDecision> {
  const regexDecision = decideByRegex(provider, message, channel);
  const preview = `${message.slice(0, 80).replace(/\s+/g, " ")}${message.length > 80 ? "…" : ""}`;

  let finalDecision = regexDecision;
  let reasonOverlay: string | null = null;

  // LLM veto layer — only invoked when regex says DELEGATE.
  // Catches user-override phrasings the regex missed.
  if (regexDecision.destination === "delegate" && process.env.LAX_ROUTE_CLASSIFIER !== "0") {
    try {
      const llmResult = await classifyRouteWithLLM(message);
      if (llmResult && llmResult.inline) {
        finalDecision = { ...regexDecision, destination: "inline" };
        reasonOverlay = `LLM-veto: ${llmResult.reason}`;
        logger.info(`LLM vetoed regex DELEGATE → INLINE: ${llmResult.reason}`);
      }
    } catch (e) {
      logger.warn(`LLM classifier failed (falling back to regex): ${(e as Error).message}`);
    }
  }

  const finalReason = reasonOverlay || finalDecision.reason;
  logger.info(
    `decision=${finalDecision.destination.toUpperCase()} reason=${finalReason} provider=${provider} words=${finalDecision.wordCount} msg="${preview}"`,
  );
  recordDecision({
    ts: Date.now(),
    delegate: finalDecision.destination === "delegate",
    reason: finalReason,
    provider,
    wordCount: finalDecision.wordCount,
    messagePreview: preview,
  });

  return { ...finalDecision, reason: finalReason };
}
