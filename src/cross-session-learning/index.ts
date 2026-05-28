/**
 * Local Agent X — Cross-Session Learning
 *
 * Detects patterns across sessions and suggests automations.
 * Tracks actions, topics, questions, and workflows to surface
 * recurring behaviors the user might want to automate.
 */

export type {
  ActionEntry,
  DetectedPattern,
  AutomationSuggestion,
  SessionInsight,
} from "./types.js";

export { CrossSessionLearner } from "./learner.js";

import { CrossSessionLearner } from "./learner.js";
export default CrossSessionLearner.getInstance();
