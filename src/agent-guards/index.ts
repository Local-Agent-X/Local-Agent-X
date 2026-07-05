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
  checkUnsupportedOperationalClaim,
  hasFreshOperationalEvidence,
  looksLikeDefinitiveOperationalClaim,
} from "./operational-claim.js";
export {
  checkUngroundedCodebaseAdvice,
  hasFreshCodebaseEvidence,
  looksLikeCodebaseAdviceRequest,
  looksLikeImplementationAdvice,
} from "./codebase-advice.js";
export {
  CLAIM_GROUNDING_RULES,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CODEBASE_ADVICE_GROUNDING_STATUS,
  claimGroundingRule,
  evaluateClaimGrounding,
  type ClaimGroundingRule,
  type ClaimKind,
  type EvidenceKind,
  type GroundingConsequence,
  type GroundingVerdict,
} from "./claim-grounding.js";
export {
  checkTaskAnchor,
  createTaskAnchorState,
  type TaskAnchorState,
} from "./task-anchor.js";
export { checkActedAndAsked } from "./acted-and-asked.js";
export {
  checkToolLoops,
  noteToolResults,
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
export {
  noteVerifyEvidence,
  checkVerifyGate,
  createVerifyGateState,
  opEditedSourceUnverified,
  recordExternalVerify,
  sourceDoneEvidence,
  isSourceFile,
  guessTestSubject,
  decideDeletedTest,
  nudgeDeletedTest,
  type VerifyGateState,
  type VerifyTurnAction,
  type TestDeletionVerdict,
} from "./verify-gate.js";
export {
  detectBuildCommand,
  detectTestCommand,
  isTestFile,
  type BuildCommand,
  type TestCommand,
  type FsProbe,
} from "./build-command.js";
export {
  looksLikeCleanupSweep,
  isEmptyGrepResult,
  claimsCleanupDone,
  noteCleanupEvidence,
  checkCleanupVerify,
  createCleanupVerifyState,
  CLEANUP_VERIFY_MAX_NUDGES,
  type CleanupVerifyState,
  type CleanupToolResult,
} from "./cleanup-verify.js";
