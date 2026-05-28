/**
 * Shared agent loop guards — anti-hallucination, loop detection, self-check.
 *
 * Used by all agent loops (canonical middlewares; legacy Standard / Codex /
 * Anthropic paths if they're still wired) to ensure consistent behavior
 * regardless of provider.
 *
 * Implementations split into ./agent-guards/* — this file is the public
 * re-export surface so callers keep importing from "../agent-guards/index.js".
 */

export { detectUnresolvedErrors, buildReflectionPrompt } from "./reflection.js";
export { checkApprovalHallucination, checkCreationHallucination, checkWorkerHallucination } from "./hallucination.js";
export { checkUnmatchedActionClaim } from "./action-claim.js";
export {
  checkTaskAnchor,
  createTaskAnchorState,
  type TaskAnchorState,
} from "./task-anchor.js";
export { checkActedAndAsked } from "./acted-and-asked.js";
export {
  checkToolLoops,
  createLoopState,
  type LoopState,
  NO_PROGRESS_LIMIT,
  NO_PROGRESS_LIMIT_WEAK,
} from "./loop-detection.js";
export { checkPostCommit } from "./post-commit.js";
export {
  checkDeadEnd,
  createDeadEndState,
  type DeadEndState,
} from "./dead-end.js";
