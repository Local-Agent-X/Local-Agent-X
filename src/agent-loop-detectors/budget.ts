// Retry budgets and per-turn counters consumed by the orchestrator. Both are
// keyed by DetectorKind and derived from the detector registry — the budgets
// and the full set of keys live there, not here.

import { DETECTORS } from "./registry.js";
import type { DetectorKind } from "./state.js";

/** Max nudges per detector kind for one turn. */
export type RetryBudget = Record<DetectorKind, number>;

/** How many nudges of each kind the orchestrator has already spent this turn. */
export type RetryCounters = Record<DetectorKind, number>;

export const DEFAULT_RETRY_BUDGET: RetryBudget =
  Object.fromEntries(DETECTORS.map(d => [d.kind, d.budget])) as RetryBudget;

export function createRetryCounters(): RetryCounters {
  return Object.fromEntries(DETECTORS.map(d => [d.kind, 0])) as RetryCounters;
}
