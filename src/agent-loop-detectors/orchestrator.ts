// Runs detectors in order, applies waiting-on-user + image-context exemptions,
// returns the first firing instruction whose budget still has room.

import {
  detectPlanningOnly,
  detectSingleActionStop,
  detectReasoningOnly,
  detectEmptyResponse,
  detectUncommittedTurn,
  detectEvidenceStale,
  detectIncompleteMultiStep,
} from "./detectors.js";
import { isWaitingOnUser } from "./patterns.js";
import type { RetryInstruction, TurnState } from "./state.js";
import {
  DEFAULT_RETRY_BUDGET,
  type RetryBudget,
  type RetryCounters,
} from "./budget.js";

/**
 * Run detectors in order, return the first firing instruction whose budget
 * still has room. Order matters — earlier detectors catch more specific
 * patterns, later ones are broader fallbacks.
 */
export function runPostTurnDetectors(
  state: TurnState,
  counters: RetryCounters,
  budget: RetryBudget = DEFAULT_RETRY_BUDGET,
): RetryInstruction | null {
  // Short-circuit: if the agent's reply signals it's waiting on user input
  // (asking for a file, credentials, a decision, etc.), none of the "do more
  // work" detectors are appropriate. Forcing another iteration just respawns
  // the browser/tools with nothing new to act on.
  if (isWaitingOnUser(state.assistantText)) return null;

  // Image-context exemption: when the user attached an image, the agent's
  // expected reply is a description / answer, not an action plan. The three
  // detectors below regex-match on phrases that read as "I'll do X" — but
  // a sentence like "I see X in the image; you could try Y" matches that
  // shape too, even though it's a complete answer. Empty-response / reasoning-
  // only / single-action-stop are still safe to run because they catch
  // genuinely broken paths (no text + no tools, etc.).
  const skipImageMisfiringDetectors = state.userMessageHasImages === true;

  const checks: Array<{ run: (s: TurnState) => RetryInstruction | null; key: keyof RetryCounters }> = [
    // Runs first: when a turn both stalls a plan and leaves enumerated steps
    // unfinished, the multi-step nudge (which preserves the per-step summaries)
    // is the right instruction to win.
    { run: detectIncompleteMultiStep, key: "incompleteMultiStep" },
    { run: detectPlanningOnly,       key: "planningOnly" },
    { run: detectSingleActionStop,   key: "singleActionStop" },
    { run: detectReasoningOnly,      key: "reasoningOnly" },
    { run: detectEmptyResponse,      key: "emptyResponse" },
    { run: detectUncommittedTurn,    key: "uncommittedTurn" },
    { run: detectEvidenceStale,      key: "evidenceStale" },
  ];
  const IMAGE_MISFIRE_KEYS = new Set<keyof RetryCounters>(["planningOnly", "uncommittedTurn", "evidenceStale"]);
  for (const { run, key } of checks) {
    if (skipImageMisfiringDetectors && IMAGE_MISFIRE_KEYS.has(key)) continue;
    const hit = run(state);
    if (!hit) continue;
    if (counters[key] >= budget[key]) continue;
    counters[key] += 1;
    return hit;
  }
  return null;
}
