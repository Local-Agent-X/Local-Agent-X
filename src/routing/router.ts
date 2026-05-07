/**
 * Router — the SINGLE owner of "should this message run inline or
 * delegate to a worker."
 *
 * Architecture:
 *   - regex-rules.ts     : three obvious INLINE shortcuts (slash, no-spawn, ack)
 *   - llm-classifier.ts  : primary decider for everything else (tools = workers)
 *   - decision-log.ts    : persistent + in-memory log for telemetry
 *   - delegate-worker.ts : actually submits the op when delegating
 *   - router.ts (this)   : orchestrates them, single public entry point
 *
 * Caller uses:
 *   const decision = await routeMessage(provider, message, channel);
 *   if (decision.destination === "delegate") {
 *     const { opId, replyText } = await delegateMessageToWorker(...);
 *     linkDecisionToOpId(opId, message);
 *   }
 *
 * Adding a regex shortcut = edit regex-rules.ts (only).
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
 *   1. Run regex shortcuts. If one hits (definitive=true), use it.
 *   2. Otherwise, ask the LLM classifier — its rule is "tools = workers,
 *      no tools = chat." It is the primary decider for ambiguous cases.
 *   3. If the LLM is unavailable / disabled, default to INLINE (safer than
 *      shipping arbitrary messages to a worker).
 *   4. Record the decision (in-memory + disk) for telemetry / training.
 *
 * LLM is opt-out via env LAX_ROUTE_CLASSIFIER=0.
 */
export async function routeMessage(
  provider: string,
  message: string,
  channel: string,
): Promise<RouteDecision> {
  const regexDecision = decideByRegex(provider, message, channel);
  const preview = `${message.slice(0, 80).replace(/\s+/g, " ")}${message.length > 80 ? "…" : ""}`;

  // Senior-dev architecture (revised 2026-05-06): the LLM classifier is
  // GONE from the live chat path. Instead of trying to predict whether a
  // turn needs a worker, we default INLINE for every regex-non-shortcut
  // message. The previous approach (Haiku/Sonnet predict on every turn)
  // misrouted simple lookups ("what does primal stand for?") to background
  // workers while also adding 200-1000ms of pre-turn latency AND requiring
  // Anthropic auth even when the user was on Codex.
  //
  // The right signal isn't "predict if this needs work" — it's "observe
  // when work is taking too long" (mid-turn escalation, follow-up phase).
  //
  // Workers are still reachable via:
  //   - The /discuss prefix (regex shortcut → INLINE — opposite, keeps user
  //     in chat) — handled in regex layer
  //   - Explicit "background this", "delegate", agent_spawn tool calls
  //   - User-initiated pin-to-worker UI controls
  //   - Auto-delegate boost path in prepare-request.ts (BUILD_NOUN_RE etc.)
  //     for unambiguous "build me an X" patterns
  //
  // Set LAX_ROUTE_CLASSIFIER=1 to RE-ENABLE the legacy predictor (off
  // switch flipped to opt-in for the rare A/B comparison case).
  let finalDecision = regexDecision;

  if (!regexDecision.definitive) {
    if (process.env.LAX_ROUTE_CLASSIFIER === "1") {
      // Opt-in: legacy predictor for A/B testing
      try {
        const llmResult = await classifyRouteWithLLM(message);
        if (llmResult) {
          finalDecision = {
            destination: llmResult.inline ? "inline" : "delegate",
            reason: `llm-optin: ${llmResult.reason}`,
            wordCount: regexDecision.wordCount,
            definitive: true,
          };
        } else {
          finalDecision = { ...regexDecision, reason: "llm-unavailable-default-inline", definitive: true };
        }
      } catch (e) {
        finalDecision = { ...regexDecision, reason: "llm-error-default-inline", definitive: true };
        logger.warn(`LLM classifier failed (defaulting to inline): ${(e as Error).message}`);
      }
    } else {
      // Default: no predictor. Inline for everything that didn't match a
      // regex shortcut. Cheap, fast, predictable. Misroutes (rare worker-
      // class tasks that should have delegated) recover via mid-turn
      // escalation in the agent loop, not a pre-turn predictor.
      finalDecision = { ...regexDecision, reason: "no-predictor-default-inline", definitive: true };
    }
  }

  logger.info(
    `decision=${finalDecision.destination.toUpperCase()} reason=${finalDecision.reason} provider=${provider} words=${finalDecision.wordCount} msg="${preview}"`,
  );
  recordDecision({
    ts: Date.now(),
    delegate: finalDecision.destination === "delegate",
    reason: finalDecision.reason,
    provider,
    wordCount: finalDecision.wordCount,
    messagePreview: preview,
  });

  return finalDecision;
}
