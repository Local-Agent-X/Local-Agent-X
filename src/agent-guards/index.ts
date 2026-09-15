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

export {
  CLAIM_GROUNDING_RULES,
  SOURCE_VERIFY_REASON,
  claimGroundingRule,
  evaluateClaimGrounding,
  type ClaimGroundingRule,
  type ClaimKind,
  type EvidenceKind,
  type GroundingConsequence,
  type GroundingVerdict,
} from "./claim-grounding.js";
export {
  checkToolLoops,
  hasSeenSuccessfulCommittingCall,
  noteToolResults,
  createLoopState,
  type LoopState,
  type StrategyPivotPattern,
  type ToolResultObservation,
  NO_PROGRESS_LIMIT,
  NO_PROGRESS_LIMIT_WEAK,
} from "./loop-detection.js";
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
