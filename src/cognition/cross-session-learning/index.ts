/**
 * Local Agent X — Cross-Session Learning
 *
 * Detects patterns across sessions and suggests automations.
 * Tracks actions, topics, questions, and workflows to surface
 * recurring behaviors the user might want to automate.
 */

export type {
  ActionEntry,
  LearnedEvidenceAuthority,
  LearnedEvidenceClass,
  LearnedEvidenceIdentity,
  OutcomeEvidence,
  DetectedPattern,
  AutomationSuggestion,
  CandidateEvidenceSnapshot,
  CandidateTransition,
  LearnedCandidate,
  LearnedCandidateState,
  SessionInsight,
} from "./types.js";

export {
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
  hasEvidenceIdentity,
} from "./types.js";

export { CrossSessionLearner } from "./learner.js";

import { CrossSessionLearner } from "./learner.js";
export default CrossSessionLearner.getInstance();
