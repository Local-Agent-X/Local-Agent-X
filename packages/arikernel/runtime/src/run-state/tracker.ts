/**
 * Run-level state tracker for stateful enforcement.
 *
 * Tracks cumulative behavior counters and a recent-event window
 * across an entire agent run. When thresholds are exceeded or
 * behavioral sequence rules match, the run enters "restricted mode"
 * which limits the agent to read-only safe actions.
 */

import { type TaintLabel, type TaintState } from "@arikernel/core";
import { isSafeReadOnlyAction, isEgressAction, MAX_EVENT_WINDOW, TOOL_CLASS_RISK_MAP } from "./safe-actions.js";
import { isSensitivePath } from "./sensitive-paths.js";
import type {
	HostnameEgressRecord,
	QuarantineInfo,
	RunStateCounters,
	RunStatePolicy,
	SecurityEvent,
} from "./types.js";

export class RunStateTracker {
	readonly counters: RunStateCounters = {
		deniedActions: 0,
		capabilityRequests: 0,
		deniedCapabilityRequests: 0,
		externalEgressAttempts: 0,
		sensitiveFileReadAttempts: 0,
	};

	private readonly _eventWindow: SecurityEvent[] = [];
	private _restricted = false;
	private _restrictedAt: string | null = null;
	private _quarantineInfo: QuarantineInfo | null = null;
	private _tainted = false;
	private _taintSources: Set<string> = new Set();
	private _accumulatedTaintLabels: TaintLabel[] = [];

	// ── Sticky state flags (H1 hardening) ──────────────────────────
	// These persist for the entire run and survive event window eviction.
	// Behavioral rules consult these so that an attacker cannot evade
	// detection by spacing steps across >20 events.
	private _sensitiveReadObserved = false;
	private _egressObserved = false;
	private _secretAccessObserved = false;
	private _escalationDeniedObserved = false;
	private _escalationDeniedClasses: Set<string> = new Set();
	private _quarantineGetCount = 0;
	private readonly _egressByHostname = new Map<string, HostnameEgressRecord>();
	private readonly _egressAllowHosts: ReadonlySet<string>;
	private readonly threshold: number;
	readonly behavioralRulesEnabled: boolean;
	/** The policy configuration used to construct this tracker. */
	readonly policy: RunStatePolicy | undefined;

	constructor(policy?: RunStatePolicy) {
		this.policy = policy;
		this.threshold = policy?.maxDeniedSensitiveActions ?? 5;
		this.behavioralRulesEnabled = policy?.behavioralRules !== false;
		this._egressAllowHosts = new Set(policy?.egressAllowHosts ?? []);
	}

	get restricted(): boolean {
		return this._restricted;
	}

	get restrictedAt(): string | null {
		return this._restrictedAt;
	}

	get quarantineInfo(): QuarantineInfo | null {
		return this._quarantineInfo;
	}

	/**
	 * Whether the run has been tainted by untrusted external input.
	 * Once set, this flag never resets — it persists for the entire run.
	 */
	get tainted(): boolean {
		return this._tainted;
	}

	/** Set of taint source types observed during this run. */
	get taintSources(): ReadonlySet<string> {
		return this._taintSources;
	}

	/** Whether a sensitive file read was observed at any point during this run. Sticky. */
	get sensitiveReadObserved(): boolean {
		return this._sensitiveReadObserved;
	}

	/** Whether an egress attempt was observed at any point during this run. Sticky. */
	get egressObserved(): boolean {
		return this._egressObserved;
	}

	/** Whether a secret/credential access was observed at any point during this run. Sticky. */
	get secretAccessObserved(): boolean {
		return this._secretAccessObserved;
	}

	/** Whether a capability denial was observed at any point during this run. Sticky. */
	get escalationDeniedObserved(): boolean {
		return this._escalationDeniedObserved;
	}

	/** The set of all tool classes that have been denied (for escalation risk comparison). */
	get escalationDeniedClasses(): ReadonlySet<string> {
		return this._escalationDeniedClasses;
	}

	/**
	 * The highest-risk denied tool class, derived from the full set.
	 * Returns null if no capability has been denied yet.
	 */
	get escalationDeniedToolClass(): string | null {
		if (this._escalationDeniedClasses.size === 0) return null;
		let max: string | null = null;
		let maxRisk = -1;
		for (const tc of this._escalationDeniedClasses) {
			const risk = TOOL_CLASS_RISK_MAP[tc] ?? 0;
			if (risk > maxRisk) {
				maxRisk = risk;
				max = tc;
			}
		}
		return max;
	}

	/** Mark that a capability was denied. Adds to the full set — survives window eviction. */
	markEscalationDenied(toolClass: string): void {
		this._escalationDeniedObserved = true;
		this._escalationDeniedClasses.add(toolClass);
	}

	// ── Cross-run seeder methods (NF-05) ──────────────────────────────
	// Called by PersistentTaintRegistry.initializeRunState() to propagate
	// sticky flags from prior runs without unsafe (as any) casts.

	/** Seed sensitive-read sticky flag from a prior persistent run. */
	seedSensitiveRead(): void {
		this._sensitiveReadObserved = true;
	}

	/** Seed secret-access sticky flag from a prior persistent run. */
	seedSecretAccess(): void {
		this._secretAccessObserved = true;
		this._sensitiveReadObserved = true;
	}

	/** Seed egress-observed sticky flag from a prior persistent run. */
	seedEgress(): void {
		this._egressObserved = true;
	}

	/** Mark the run as tainted by an external source. Sticky — never resets. */
	markTainted(source: string): void {
		this._tainted = true;
		this._taintSources.add(source);
	}

	/**
	 * Accumulate taint labels into the run-level taint state.
	 *
	 * Deduplicates by source:origin key so repeated labels don't bloat the set.
	 * This is the kernel's independent taint record — it persists even if tools
	 * or agents omit taint metadata from subsequent calls.
	 */
	accumulateTaintLabels(labels: TaintLabel[]): void {
		for (const label of labels) {
			const key = `${label.source}:${label.origin}`;
			if (!this._accumulatedTaintLabels.some((l) => `${l.source}:${l.origin}` === key)) {
				this._accumulatedTaintLabels.push(label);
			}
			this.markTainted(label.source);
		}
	}

	/** Read-only view of accumulated taint labels for the run. */
	get accumulatedTaintLabels(): readonly TaintLabel[] {
		return this._accumulatedTaintLabels;
	}

	/** Snapshot the kernel-maintained taint state for this run. */
	get taintState(): TaintState {
		return {
			tainted: this._tainted,
			sources: [...this._taintSources],
			labels: [...this._accumulatedTaintLabels],
		};
	}

	/** Read-only view of recent events. */
	get recentEvents(): readonly SecurityEvent[] {
		return this._eventWindow;
	}

	/**
	 * Maximum HTTP GETs with query parameters allowed after quarantine.
	 * Prevents slow-drip exfiltration via small GET requests that individually
	 * pass isSuspiciousGetExfil() thresholds.
	 */
	static readonly MAX_QUARANTINE_GETS_WITH_PARAMS = 3;

	/** Count of HTTP GETs with query params since quarantine. */
	get quarantineGetCount(): number {
		return this._quarantineGetCount;
	}

	/** Record a GET-with-params in quarantine mode. Returns true if budget exhausted. */
	recordQuarantineGet(): boolean {
		this._quarantineGetCount++;
		// After sensitive read, budget is 0 — block ALL parameterized GETs
		if (this._sensitiveReadObserved) return true;
		return this._quarantineGetCount > RunStateTracker.MAX_QUARANTINE_GETS_WITH_PARAMS;
	}

	/** Record cumulative HTTP GET egress bytes for a hostname. */
	recordHttpGetEgress(url: string): void {
		try {
			const parsed = new URL(url);
			const hostname = parsed.hostname;
			const queryBytes = parsed.search.length;
			const record = this._egressByHostname.get(hostname) ?? {
				totalQueryBytes: 0,
				requestCount: 0,
			};
			record.totalQueryBytes += queryBytes;
			record.requestCount++;
			this._egressByHostname.set(hostname, record);
		} catch {
			/* ignore invalid URLs */
		}
	}

	/** Get cumulative egress record for a hostname. */
	getCumulativeEgress(hostname: string): HostnameEgressRecord | undefined {
		return this._egressByHostname.get(hostname);
	}

	/** Check if a hostname is in the egress allowlist. */
	isAllowlistedHost(hostname: string): boolean {
		return this._egressAllowHosts.has(hostname);
	}

	/** Total cumulative query-string bytes across all hostnames. */
	get totalEgressQueryBytes(): number {
		let total = 0;
		for (const record of this._egressByHostname.values()) {
			total += record.totalQueryBytes;
		}
		return total;
	}

	/** Check if an action is allowed in restricted mode. */
	isAllowedInRestrictedMode(toolClass: string, action: string): boolean {
		return isSafeReadOnlyAction(toolClass, action);
	}

	/** Push a security event into the recent window. */
	pushEvent(event: SecurityEvent): void {
		this._eventWindow.push(event);
		if (this._eventWindow.length > MAX_EVENT_WINDOW) {
			this._eventWindow.shift();
		}
	}

	/** Enter quarantine via behavioral rule. Returns QuarantineInfo if newly quarantined. */
	quarantineByRule(
		ruleId: string,
		reason: string,
		matchedEvents: SecurityEvent[],
	): QuarantineInfo | null {
		if (this._restricted) return null;
		const info: QuarantineInfo = {
			triggerType: "behavioral_rule",
			ruleId,
			reason,
			countersSnapshot: { ...this.counters },
			matchedEvents,
			timestamp: new Date().toISOString(),
		};
		this._restricted = true;
		this._restrictedAt = info.timestamp;
		this._quarantineInfo = info;
		this.pushEvent({
			timestamp: info.timestamp,
			type: "quarantine_entered",
			metadata: { ruleId, reason },
		});
		return info;
	}

	/** Record a denied action and check if we should enter restricted mode. */
	recordDeniedAction(): void {
		this.counters.deniedActions++;
		this.checkThreshold();
	}

	/** Record a capability request. */
	recordCapabilityRequest(granted: boolean): void {
		this.counters.capabilityRequests++;
		if (!granted) {
			this.counters.deniedCapabilityRequests++;
		}
	}

	/** Record an external egress attempt (HTTP write to any host). */
	recordEgressAttempt(): void {
		this.counters.externalEgressAttempts++;
		this._egressObserved = true;
	}

	/**
	 * Record a sensitive file read attempt (pre-policy).
	 * Increments the counter for quarantine threshold checks, but does NOT set
	 * the sticky sensitiveReadObserved flag. That flag is only set when the read
	 * is actually allowed (via confirmSensitiveFileRead()), preventing an attacker
	 * from "framing" a principal by attempting denied sensitive reads to trigger
	 * cross-principal contamination marking.
	 */
	recordSensitiveFileAttempt(): void {
		this.counters.sensitiveFileReadAttempts++;
	}

	/**
	 * Confirm that a sensitive file read was actually executed (post-policy allow).
	 * Sets the sticky sensitiveReadObserved flag which is used for:
	 * - Cross-principal contamination marking (shared taint registry)
	 * - Post-sensitive-read egress restrictions
	 *
	 * Only call this AFTER policy evaluation allows the read AND execution succeeds.
	 */
	confirmSensitiveFileRead(): void {
		this._sensitiveReadObserved = true;
	}

	/** Mark that a secret/credential resource was accessed. Sticky. */
	markSecretAccess(): void {
		this._secretAccessObserved = true;
	}

	/** Check if a file path targets a sensitive location. NFKC-normalized to prevent homoglyph bypass. */
	isSensitivePath(path: string): boolean {
		return isSensitivePath(path);
	}

	/**
	 * Check if an HTTP action is a true egress (outbound write) attempt.
	 * Only write methods are egress. GET/HEAD are ingress (content fetch).
	 * Suspicious GET-based exfil is detected separately by isSuspiciousGetExfil().
	 */
	isEgressAction(action: string): boolean {
		return isEgressAction(action);
	}

	private checkThreshold(): void {
		if (this._restricted) return;
		if (this.counters.deniedActions >= this.threshold) {
			const ts = new Date().toISOString();
			this._restricted = true;
			this._restrictedAt = ts;
			this._quarantineInfo = {
				triggerType: "threshold",
				reason: `Denied actions (${this.counters.deniedActions}) exceeded threshold (${this.threshold})`,
				countersSnapshot: { ...this.counters },
				timestamp: ts,
			};
			this.pushEvent({
				timestamp: ts,
				type: "quarantine_entered",
				metadata: { triggerType: "threshold" },
			});
		}
	}
}
