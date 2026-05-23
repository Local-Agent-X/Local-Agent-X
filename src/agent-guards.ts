/**
 * Shared agent loop guards — anti-hallucination, loop detection, self-check.
 *
 * Used by all agent loops (canonical middlewares; legacy Standard / Codex /
 * Anthropic paths if they're still wired) to ensure consistent behavior
 * regardless of provider.
 *
 * Implementations split into ./agent-guards/* — this file is the public
 * re-export surface so callers keep importing from "../agent-guards.js".
 */

export { detectUnresolvedErrors, buildReflectionPrompt } from "./agent-guards/reflection.js";
export { checkApprovalHallucination, checkCreationHallucination, checkWorkerHallucination } from "./agent-guards/hallucination.js";
export { checkUnmatchedActionClaim } from "./agent-guards/action-claim.js";
export {
  checkTaskAnchor,
  createTaskAnchorState,
  type TaskAnchorState,
} from "./agent-guards/task-anchor.js";
export { checkActedAndAsked } from "./agent-guards/acted-and-asked.js";
export {
  checkToolLoops,
  createLoopState,
  type LoopState,
  NO_PROGRESS_LIMIT,
  NO_PROGRESS_LIMIT_WEAK,
} from "./agent-guards/loop-detection.js";
export { checkPostCommit } from "./agent-guards/post-commit.js";
export {
  checkDeadEnd,
  createDeadEndState,
  type DeadEndState,
} from "./agent-guards/dead-end.js";
