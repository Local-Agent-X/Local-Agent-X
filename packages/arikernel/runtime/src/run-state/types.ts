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
	/**
	 * The host's own credential-file classifier. When given it replaces the
	 * built-in catalog for every sensitive-path decision (rule 3, the sticky
	 * read flag, the post-read GET header check), so the kernel and the host
	 * can never disagree on what a credential file is. The path is NFKC-
	 * normalized before it is handed over.
	 */
	sensitivePath?: (path: string) => boolean;
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
	| "rule_denied"
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

// ── Rule denials and quarantine metadata ───────────────────────────

/**
 * One call refused by a behavioral sequence rule. The match refuses that
 * call only; the run goes on. The refusal is counted, and a run that keeps
 * being refused is restricted by the denied-action threshold.
 */
export interface RuleDenial {
	ruleId: string;
	reason: string;
	matchedEvents: SecurityEvent[];
	/** The denied-action counter after this refusal was counted. */
	deniedActions: number;
	/** Refusals that restrict the run to read-only for the rest of it. */
	threshold: number;
	/** True when this refusal was the one that restricted the run. */
	restricted: boolean;
	timestamp: string;
}

/** "threshold": the denied-action counter reached its limit. "external": a
 *  host-side correlator restricted the run outright (quarantineExternal). */
export type QuarantineTrigger = "threshold" | "external";

export interface QuarantineInfo {
	triggerType: QuarantineTrigger;
	/** threshold: the rule behind the refusal that reached it, when it was one. */
	ruleId?: string;
	reason: string;
	countersSnapshot: RunStateCounters;
	matchedEvents?: SecurityEvent[];
	timestamp: string;
}

// ── Cumulative egress tracking ─────────────────────────────────────

export interface HostnameEgressRecord {
	totalQueryBytes: number;
	/** Cumulative encoded-looking URL-path bytes sent to this host (H11 drip). */
	totalPathPayloadBytes: number;
	requestCount: number;
}
