/**
 * Routing module — single owner of the "should this message run inline
 * or delegate to a worker" decision. Re-exports the public API so callers
 * get one import path.
 *
 * See router.ts for the architecture overview.
 */

export { routeMessage } from "./router.js";
export { hasDiscussPrefix, stripDiscussPrefix } from "./regex-rules.js";
export {
  recordDecision,
  getRecentAutoDelegateDecisions,
  linkDecisionToOpId,
  markDecisionAsUserOverride,
} from "./decision-log.js";
export type { RouteDecision, RouteDestination, AutoDelegateLogEntry, ClassifierResult } from "./types.js";
