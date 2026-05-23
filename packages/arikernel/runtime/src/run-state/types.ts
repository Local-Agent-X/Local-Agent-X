/**
 * Shared types for run-state tracking.
 */

export interface RunStatePolicy {
	/** Number of denied sensitive actions before entering restricted mode. Default: 5 */
	maxDeniedSensitiveActions?: number;
	/** Whether behavioral sequence rules are enabled. Default: true */
	behavioralRules?: boolean;
	/** Hostnames exempted from post-sensitive-read egress tightening. */
	egressAllowHosts?: string[];
}

export interface RunStateCounters {
	deniedActions: number;
	capabilityRequests: number;
	deniedCapabilityRequests: number;
	externalEgressAttempts: number;
	sensitiveFileReadAttempts: number;
}

// ── Recent-event window types ──────────────────────────────────────

export type SecurityEventType =
	| "capability_requested"
	| "capability_denied"
	| "capability_granted"
	| "tool_call_allowed"
	| "tool_call_denied"
	| "taint_observed"
	| "sensitive_read_attempt"
	| "sensitive_read_allowed"
	| "egress_attempt"
	| "quarantine_entered";

export interface SecurityEvent {
	timestamp: string;
	type: SecurityEventType;
	toolClass?: string;
	action?: string;
	verdict?: "allow" | "deny" | "require-approval";
	taintSources?: string[];
	metadata?: Record<string, unknown>;
}

// ── Quarantine metadata ────────────────────────────────────────────

export type QuarantineTrigger = "threshold" | "behavioral_rule";

export interface QuarantineInfo {
	triggerType: QuarantineTrigger;
	ruleId?: string;
	reason: string;
	countersSnapshot: RunStateCounters;
	matchedEvents?: SecurityEvent[];
	timestamp: string;
}

// ── Cumulative egress tracking ─────────────────────────────────────

export interface HostnameEgressRecord {
	totalQueryBytes: number;
	requestCount: number;
}
