/**
 * Local Agent X — Cross-Session Learning
 *
 * The candidate store behind learned procedures: each procedure the post-turn
 * review proposed, the sessions that proposed it, and its activation state.
 */

export type {
  LearnedEvidenceAuthority,
  LearnedEvidenceClass,
  LearnedEvidenceIdentity,
  DetectedPattern,
  AutomationSuggestion,
  CandidateEvidenceSnapshot,
  CandidateTransition,
  LearnedCandidate,
  LearnedCandidateState,

} from "./types.js";

export {
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
  hasEvidenceIdentity,
} from "./types.js";

export { CrossSessionLearner } from "./learner.js";

import { CrossSessionLearner } from "./learner.js";
export default CrossSessionLearner.getInstance();
