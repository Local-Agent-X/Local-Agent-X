// Runs the registered detectors in order, applies the waiting-on-user and
// image-context exemptions, and returns the first firing instruction whose
// budget still has room.

import { DETECTORS } from "./registry.js";
import { isWaitingOnUser } from "./patterns.js";
import type { RetryInstruction, TurnState } from "./state.js";
import {
  DEFAULT_RETRY_BUDGET,
  type RetryBudget,
  type RetryCounters,
} from "./budget.js";

/**
 * Run detectors in registry order, return the first firing instruction whose
 * budget still has room. Order matters — earlier detectors catch more specific
 * patterns, later ones are broader fallbacks (see registry.ts).
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

  const skipImageMisfiringDetectors = state.userMessageHasImages === true;

  for (const spec of DETECTORS) {
    if (skipImageMisfiringDetectors && spec.skipOnImages) continue;
    const hit = spec.run(state);
    if (!hit) continue;
    if (counters[spec.kind] >= budget[spec.kind]) continue;
    counters[spec.kind] += 1;
    return hit;
  }
  return null;
}
