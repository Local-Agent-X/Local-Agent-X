/**
 * Public surface for run-state tracking — re-exports from ./run-state/.
 *
 * Modules:
 *   - tracker.ts          RunStateTracker class
 *   - types.ts            Shared interfaces and type aliases
 *   - exfil-detection.ts  URL/header data-exfil heuristics
 *   - sensitive-paths.ts  Sensitive file path matcher
 *   - safe-actions.ts     Restricted-mode action classifier + risk map
 */

export { RunStateTracker } from "./run-state/tracker.js";
export type {
	HostnameEgressRecord,
	QuarantineInfo,
	QuarantineTrigger,
	RunStateCounters,
	RunStatePolicy,
	SecurityEvent,
	SecurityEventType,
} from "./run-state/types.js";
export {
	hasEncodedPayload,
	isSuspiciousGetExfil,
	suspiciousHeaderValue,
} from "./run-state/exfil-detection.js";
