// Retry budgets and per-turn counters consumed by the orchestrator.

export interface RetryBudget {
  planningOnly: number;
  singleActionStop: number;
  reasoningOnly: number;
  emptyResponse: number;
  uncommittedTurn: number;
  evidenceStale: number;
  incompleteMultiStep: number;
}

export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  planningOnly: 2,
  singleActionStop: 2,
  reasoningOnly: 2,
  emptyResponse: 2,
  uncommittedTurn: 1,
  evidenceStale: 1,
  // One nudge per remaining step for a reasonably long enumerated task.
  incompleteMultiStep: 8,
};

export interface RetryCounters {
  planningOnly: number;
  singleActionStop: number;
  reasoningOnly: number;
  emptyResponse: number;
  uncommittedTurn: number;
  evidenceStale: number;
  incompleteMultiStep: number;
}

export function createRetryCounters(): RetryCounters {
  return {
    planningOnly: 0,
    singleActionStop: 0,
    reasoningOnly: 0,
    emptyResponse: 0,
    uncommittedTurn: 0,
    evidenceStale: 0,
    incompleteMultiStep: 0,
  };
}
