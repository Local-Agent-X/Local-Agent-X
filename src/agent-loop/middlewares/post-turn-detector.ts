/**
 * Post-turn detector stack — wraps runPostTurnDetectors from
 * agent-loop-detectors.ts. Catches: planning-only turns,
 * single-action-stop, evidence-stale, uncommitted turns, etc. When a
 * detector fires, it sets ctx.promptLayers.retry so the NEXT iteration's
 * recomposed system prompt carries the nudge — same pattern legacy
 * uses. Returns retry-iteration so the loop runs again with the layer
 * applied.
 *
 * Per-turn state (retryCounters, evidenceHistory) lives on ctx:
 * evidenceHistory is already part of LoopContext; retryCounters lives
 * in a WeakMap keyed by ctx.
 */

import type { LoopMiddleware, LoopContext } from "../types.js";

const RETRY_STATE = new WeakMap<LoopContext, ReturnType<typeof import("../../agent-loop-detectors.js")["createRetryCounters"]>>();

async function getRetryCounters(ctx: LoopContext) {
  let s = RETRY_STATE.get(ctx);
  if (!s) {
    const { createRetryCounters } = await import("../../agent-loop-detectors.js");
    s = createRetryCounters();
    RETRY_STATE.set(ctx, s);
  }
  return s;
}

export const postTurnDetectorMiddleware: LoopMiddleware = {
  name: "post-turn-detector",

  async afterModelCall(ctx, result) {
    const { runPostTurnDetectors, computeEvidenceCount, userMessageHasImages } =
      await import("../../agent-loop-detectors.js");
    const counters = await getRetryCounters(ctx);

    ctx.evidenceHistory.push(computeEvidenceCount(ctx.messages));

    const detectorState = {
      assistantText: result.assistantContent,
      toolCallsThisIteration: result.toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })),
      toolsCalledThisTurn: ctx.toolsCalledThisTurn,
      hasReasoning: false,
      completionTokens: ctx.totalOutput,
      iteration: ctx.iteration,
      evidenceCount: ctx.evidenceHistory[ctx.evidenceHistory.length - 1],
      evidenceHistory: [...ctx.evidenceHistory],
      userMessageHasImages: userMessageHasImages(ctx.messages as Array<{ role: string; content: unknown }>),
    };

    const hit = runPostTurnDetectors(detectorState, counters);
    if (hit) {
      // Stuff the nudge into the prompt-layer slot so the next iteration's
      // recomposed system prompt carries it. retry-iteration lets the loop
      // re-enter with the layer applied without pushing a synthetic user
      // message (same pattern the legacy loop used).
      ctx.promptLayers.retry = hit;
      return { kind: "retry-iteration" };
    }
    // Clear stale retry layer so it doesn't leak into the next iteration
    // when the previous one's nudge resolved.
    ctx.promptLayers.retry = undefined;
    return { kind: "continue" };
  },
};
