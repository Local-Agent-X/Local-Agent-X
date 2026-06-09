import { AuditStore, type ReplayResult, replayRun } from "@arikernel/audit-log";
import type {
	AuditEvent,
	Capability,
	CapabilityClass,
	CapabilityConstraint,
	CapabilityGrant,
	DelegatedCapability,
	DelegationResult,
	IssuanceDecision,
	Principal,
	TaintLabel,
	ToolCallRequest,
	ToolResult,
} from "@arikernel/core";
import { PolicyEngine } from "@arikernel/policy-engine";
import { TaintTracker } from "@arikernel/taint-tracker";
import type { ToolExecutor } from "@arikernel/tool-executors";
import { ExecutorRegistry } from "@arikernel/tool-executors";
import type { EnforcementMode, FirewallOptions } from "./config.js";
import { type AuditOptions, audit as auditCall } from "./firewall/audit.js";
import { constructFirewall } from "./firewall/construct.js";
import {
	delegateToChild,
	quarantineExternal,
	revokeDelegationsFromPrincipal,
} from "./firewall/delegation.js";
import { execute as executeRequest } from "./firewall/execution.js";
import {
	type RequestOptions,
	requestCapabilityAsync,
	requestCapabilitySync,
} from "./firewall/issuance.js";
import {
	type Observation,
	injectExternalTaint,
	observeToolOutput,
} from "./firewall/observation.js";
import type { FirewallHooks } from "./hooks.js";
import { CapabilityIssuer } from "./issuer.js";
import { PersistentTaintRegistry } from "./persistent-taint-registry.js";
import { Pipeline } from "./pipeline.js";
import {
	type QuarantineInfo,
	type RunStateCounters,
	RunStateTracker,
} from "./run-state.js";
import { SidecarHttpClient } from "./sidecar-proxy.js";
import { type ITokenStore, TokenStore } from "./token-store.js";

export class Firewall {
	private principal: Principal;
	private policyEngine: PolicyEngine;
	private taintTracker: TaintTracker;
	private auditStore: AuditStore;
	private executorRegistry: ExecutorRegistry;
	private pipeline: Pipeline;
	private issuer: CapabilityIssuer;
	private tokenStore: ITokenStore;
	private _hooks: FirewallHooks;
	private _runState: RunStateTracker;
	private _persistentTaint: PersistentTaintRegistry | null = null;
	private readonly _mode: EnforcementMode;
	private readonly _sidecarOptions?: import("./config.js").SidecarConnectionOptions;
	private readonly _sidecarClient?: SidecarHttpClient;
	readonly runId: string;

	constructor(options: FirewallOptions) {
		const c = constructFirewall(options);
		this.runId = c.runId;
		this.principal = c.principal;
		this.policyEngine = c.policyEngine;
		this.taintTracker = c.taintTracker;
		this.auditStore = c.auditStore;
		this.executorRegistry = c.executorRegistry;
		this.pipeline = c.pipeline;
		this.issuer = c.issuer;
		this.tokenStore = c.tokenStore;
		this._hooks = c.hooks;
		this._runState = c.runState;
		this._persistentTaint = c.persistentTaint;
		this._mode = c.mode;
		this._sidecarOptions = c.sidecarOptions;
		this._sidecarClient = c.sidecarClient;
	}

	/**
	 * Request a capability grant.
	 *
	 * **Sidecar mode (compatibility-only):** Returns a synthetic, non-authoritative
	 * grant immediately. This grant is NEVER used as an enforcement decision —
	 * the real allow/deny comes from the sidecar when `execute()` is called.
	 * The synthetic grant exists solely for backward compatibility with callers
	 * that expect a synchronous return value. No code path can use this grant
	 * to bypass sidecar authority because `execute()` routes directly to the
	 * sidecar and never consults the local token store.
	 *
	 * Prefer `requestCapabilityAsync()` in sidecar mode for a real sidecar decision.
	 *
	 * **Embedded mode:** Evaluates policy locally and returns synchronously.
	 */
	requestCapability(
		capabilityClass: CapabilityClass,
		options?: RequestOptions,
	): IssuanceDecision {
		return requestCapabilitySync(this._issuanceCtx(), capabilityClass, options);
	}

	/**
	 * Request a capability grant asynchronously.
	 *
	 * In sidecar mode, routes to the sidecar `/request-capability` endpoint.
	 * The sidecar is the authoritative decision source.
	 *
	 * In embedded mode, delegates to the synchronous local evaluator.
	 */
	async requestCapabilityAsync(
		capabilityClass: CapabilityClass,
		options?: RequestOptions,
	): Promise<IssuanceDecision> {
		return requestCapabilityAsync(this._issuanceCtx(), capabilityClass, options);
	}

	registerExecutor(executor: ToolExecutor): void {
		if (this._mode === "sidecar") {
			throw new Error(
				"Cannot register local executors in sidecar mode. " +
					"Tool execution is delegated to the sidecar process. " +
					"Register executors on the sidecar server instead.",
			);
		}
		this.executorRegistry.register(executor);
	}

	async execute(request: ToolCallRequest): Promise<ToolResult> {
		return executeRequest(
			{
				principal: this.principal,
				runId: this.runId,
				pipeline: this.pipeline,
				hooks: this._hooks,
				sidecarClient: this._sidecarClient,
			},
			request,
		);
	}

	/**
	 * Observe real tool output after external execution (middleware mode).
	 *
	 * In middleware mode, stub executors don't perform real I/O — the framework
	 * executes the tool directly. This method allows adapters to feed real tool
	 * output back into the kernel for content scanning, taint derivation,
	 * run-state updates, and behavioral event emission.
	 *
	 * This closes the "middleware taint gap" for adapters that support it.
	 * Adapters that cannot provide output continue operating in degraded mode.
	 */
	observeToolOutput(observation: Observation): TaintLabel[] {
		return observeToolOutput(
			{
				principal: this.principal,
				runId: this.runId,
				taintTracker: this.taintTracker,
				runState: this._runState,
				auditStore: this.auditStore,
			},
			observation,
		);
	}

	replay(runId?: string): ReplayResult | null {
		return replayRun(this.auditStore, runId ?? this.runId);
	}

	getEvents(runId?: string): AuditEvent[] {
		return this.auditStore.queryRun(runId ?? this.runId);
	}

	activeGrants(): CapabilityGrant[] {
		return this.tokenStore.activeGrants(this.principal.id);
	}

	revokeGrant(grantId: string): boolean {
		return this.tokenStore.revoke(grantId);
	}

	/** Whether this run has entered restricted mode. */
	get isRestricted(): boolean {
		return this._runState.restricted;
	}

	/** Timestamp when restricted mode was entered, or null. */
	get restrictedAt(): string | null {
		return this._runState.restrictedAt;
	}

	/** Current run-state counters. */
	get runStateCounters(): RunStateCounters {
		return { ...this._runState.counters };
	}

	/** Quarantine metadata if the run has been quarantined. */
	get quarantineInfo(): QuarantineInfo | null {
		return this._runState.quarantineInfo;
	}

	/** Kernel-maintained taint state for this run. */
	get taintState(): import("@arikernel/core").TaintState {
		return this._runState.taintState;
	}

	/** Whether this run has observed a sensitive file read (sticky flag). */
	get sensitiveReadObserved(): boolean {
		return this._runState.sensitiveReadObserved;
	}

	/**
	 * Audit-only path for tool calls with no agent-controlled I/O sink
	 * (toolClass: "internal"). Writes the call into the hash-chained audit
	 * store as if it were a gated call AND feeds it through the behavioral-
	 * rules pipeline — so a session that calls `app_delete` 50 times in 30s
	 * trips the same quarantine logic that a session abusing `bash` would.
	 *
	 * Distinct from execute(): no policy evaluation, no capability check,
	 * no taint propagation. The decision is always allow; the audit entry
	 * carries `reason: "audit-only"` so downstream replay/analysis can
	 * filter it out from gated decisions if needed.
	 *
	 * Returns the QuarantineInfo when behavioral rules just triggered a new
	 * quarantine for this run (so the caller can surface it), or null
	 * otherwise. Never throws — DB failures are swallowed and logged via
	 * onAudit hook absence; the caller must not depend on audit success
	 * for tool execution.
	 */
	audit(opts: AuditOptions): QuarantineInfo | null {
		return auditCall(
			{
				principal: this.principal,
				runId: this.runId,
				runState: this._runState,
				auditStore: this.auditStore,
				hooks: this._hooks,
			},
			opts,
		);
	}

	/**
	 * Quarantine this firewall externally (e.g., from a cross-principal correlator alert).
	 * Returns QuarantineInfo if newly quarantined, null if already restricted.
	 */
	quarantineExternal(ruleId: string, reason: string): QuarantineInfo | null {
		return quarantineExternal(
			{
				principal: this.principal,
				runState: this._runState,
				auditStore: this.auditStore,
				runId: this.runId,
			},
			ruleId,
			reason,
		);
	}

	/**
	 * Inject external taint labels into this firewall's run-state.
	 * Used by cross-principal systems (e.g., SharedTaintRegistry) to propagate
	 * contamination from one principal's actions to another.
	 */
	injectExternalTaint(labels: TaintLabel[]): void {
		injectExternalTaint(
			{
				principal: this.principal,
				runId: this.runId,
				taintTracker: this.taintTracker,
				runState: this._runState,
				auditStore: this.auditStore,
			},
			labels,
		);
	}

	/**
	 * Delegate a subset of this firewall's principal capabilities to a child principal.
	 *
	 * The child receives the intersection of the parent's capabilities and
	 * the requested capabilities — delegation can only narrow, never widen.
	 *
	 * Returns a new Firewall instance bound to the child principal.
	 */
	delegateToChild(
		childName: string,
		requestedCapabilities: Capability[],
	): { firewall: Firewall; denied: DelegationResult[] } {
		return delegateToChild<Firewall>(
			{
				principal: this.principal,
				policyEngine: this.policyEngine,
				hooks: this._hooks,
				runState: this._runState,
				mode: this._mode,
				sidecarOptions: this._sidecarOptions,
				auditStore: this.auditStore,
				runId: this.runId,
			},
			childName,
			requestedCapabilities,
			(options) => new Firewall(options),
			(firewall, principal) => {
				// biome-ignore lint/suspicious/noExplicitAny: accessing private field for delegation
				(firewall as any).principal = principal;
			},
		);
	}

	/**
	 * Revoke all capabilities that were delegated through a specific principal.
	 *
	 * Transitive: if A → B → C, revoking B removes C's delegated capabilities too.
	 */
	revokeDelegationsFrom(principalId: string): void {
		this.principal.capabilities = revokeDelegationsFromPrincipal(this.principal, principalId);
	}

	/** The enforcement mode this firewall is operating in. */
	get enforcementMode(): EnforcementMode {
		return this._mode;
	}

	/** The principal bound to this firewall instance. */
	get principalInfo(): Readonly<Principal> {
		return this.principal;
	}

	/** The persistent taint registry, if cross-run tracking is enabled. */
	get persistentTaintRegistry(): PersistentTaintRegistry | null {
		return this._persistentTaint;
	}

	close(): void {
		this._persistentTaint?.purgeExpired();
		this.auditStore.endRun(this.runId);
		this.auditStore.close();
	}

	private _issuanceCtx() {
		return {
			principal: this.principal,
			issuer: this.issuer,
			runState: this._runState,
			auditStore: this.auditStore,
			runId: this.runId,
			hooks: this._hooks,
			sidecarClient: this._sidecarClient,
		};
	}
}

export function createFirewall(options: FirewallOptions): Firewall {
	return new Firewall(options);
}
