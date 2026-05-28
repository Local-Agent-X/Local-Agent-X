// Post-turn validation detectors.
//
// When the model emits a response, Local Agent X used to treat it as terminal: any
// emitted text → return end_turn, we're done. That's wrong. A turn can be
// incomplete in several distinct ways that look like a clean exit:
//   - Planning-only: "I'll do X next" with zero tool calls
//   - Single-exploratory-tool-then-stop: agent ran `ls`/`read` once and
//     promised continuation but stopped
//   - Reasoning-only: reasoning tokens emitted, no user-visible text
//   - Empty response: zero text + zero tools + zero tokens (provider hiccup)
//   - Uncommitted turn: made tool calls but none of them committed anything
//   - Stale evidence: running the same queries with no new information
//
// Each detector is a pure function that returns either null (turn is fine)
// or a RetryInstruction (inject this nudge, continue the loop). The agent
// loop runs these in order before returning end_turn; any firing detector
// short-circuits the exit.
//
// This file is a barrel — implementation lives under ./agent-loop-detectors/.

export {
  PLANNING_ONLY_INSTRUCTION,
  SINGLE_ACTION_STOP_INSTRUCTION,
  REASONING_ONLY_INSTRUCTION,
  EMPTY_RESPONSE_INSTRUCTION,
  UNCOMMITTED_TURN_INSTRUCTION,
  EVIDENCE_STALE_INSTRUCTION,
} from "./instructions.js";

export { isWaitingOnUser } from "./patterns.js";

export {
  userMessageHasImages,
  type DetectorKind,
  type RetryInstruction,
  type TurnState,
} from "./state.js";

export {
  detectPlanningOnly,
  detectSingleActionStop,
  detectReasoningOnly,
  detectEmptyResponse,
  detectUncommittedTurn,
  detectEvidenceStale,
} from "./detectors.js";

export {
  DEFAULT_RETRY_BUDGET,
  createRetryCounters,
  type RetryBudget,
  type RetryCounters,
} from "./budget.js";

export { runPostTurnDetectors } from "./orchestrator.js";

export { computeEvidenceCount } from "./evidence.js";
