import { AuditStore } from "@arikernel/audit-log";
import type { Principal } from "@arikernel/core";
import { generateId } from "@arikernel/core";
import { PolicyEngine } from "@arikernel/policy-engine";
import { TaintTracker } from "@arikernel/taint-tracker";
import { ExecutorRegistry } from "@arikernel/tool-executors";
import type { EnforcementMode, FirewallOptions } from "../config.js";
import { validateOptions } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import { CapabilityIssuer } from "../issuer.js";
import { PersistentTaintRegistry } from "../persistent-taint-registry.js";
import { Pipeline } from "../pipeline.js";
import { RunStateTracker } from "../run-state.js";
import { SidecarHttpClient, createSidecarProxies } from "../sidecar-proxy.js";
import { type ITokenStore, TokenStore } from "../token-store.js";

export interface ConstructedFirewall {
	runId: string;
	principal: Principal;
	policyEngine: PolicyEngine;
	taintTracker: TaintTracker;
	auditStore: AuditStore;
	executorRegistry: ExecutorRegistry;
	pipeline: Pipeline;
	issuer: CapabilityIssuer;
	tokenStore: ITokenStore;
	hooks: FirewallHooks;
	runState: RunStateTracker;
	persistentTaint: PersistentTaintRegistry | null;
	mode: EnforcementMode;
	sidecarOptions?: import("../config.js").SidecarConnectionOptions;
	sidecarClient?: SidecarHttpClient;
}

export function constructFirewall(options: FirewallOptions): ConstructedFirewall {
	validateOptions(options);

	// Enforcement mode must be explicit in production.
	// Omitting it in production is a misconfiguration — fail fast rather than
	// silently falling back to cooperative (embedded) enforcement.
	if (options.mode === undefined) {
		if (process.env.NODE_ENV === "production") {
			throw new Error(
				"AriKernel: enforcement mode must be explicit in production. " +
					"Set mode: 'sidecar' (recommended) or mode: 'embedded' (trusted environments only). " +
					"See the sidecar-mode docs for minimum sidecar setup.",
			);
		}
		console.warn(
			"[AriKernel] No enforcement mode set — defaulting to 'embedded'. " +
				"Embedded mode runs tools in-process and is not suitable for production. " +
				"Set mode: 'sidecar' for production deployments.",
		);
	}

	const mode: EnforcementMode = options.mode ?? "embedded";
	const sidecarOptions = options.sidecar;

	// Embedded mode in production is allowed only when explicitly chosen,
	// but warn clearly — it provides cooperative enforcement only.
	if (mode === "embedded" && process.env.NODE_ENV === "production") {
		console.warn(
			"[AriKernel] Embedded mode is active in production. " +
				"Enforcement is cooperative — the host process can bypass the pipeline. " +
				"Use mode: 'sidecar' for strongest enforcement in production.",
		);
	}

	if (mode === "sidecar" && !options.sidecar) {
		throw new Error(
			'Firewall mode is "sidecar" but no sidecar connection options were provided. ' +
				"Set options.sidecar with baseUrl and authToken.",
		);
	}

	const runId = generateId();

	const principal: Principal = {
		id: generateId(),
		name: options.principal.name,
		capabilities: options.principal.capabilities,
	};

	const policyEngine = new PolicyEngine(options.policies);
	const taintTracker = new TaintTracker();
	const auditStore = new AuditStore(options.auditLog ?? "./audit.db");
	const executorRegistry = new ExecutorRegistry();
	const tokenStore: ITokenStore = options.tokenStore ?? new TokenStore();

	// In sidecar mode, the Firewall acts as a thin client. All policy
	// evaluation, token management, behavioral rules, taint tracking, and
	// tool execution are delegated to the sidecar over HTTP.
	// SidecarProxyExecutors are still registered for backward compatibility
	// (e.g., if anything calls pipeline.intercept directly), but the primary
	// path bypasses the local pipeline entirely.
	let sidecarClient: SidecarHttpClient | undefined;
	if (mode === "sidecar") {
		const principalId = options.sidecar?.principalId ?? options.principal.name;
		const proxyConfig = {
			baseUrl: options.sidecar?.baseUrl,
			principalId,
			authToken: options.sidecar?.authToken,
		};
		sidecarClient = new SidecarHttpClient({
			baseUrl: options.sidecar?.baseUrl ?? "http://localhost:8787",
			principalId,
			authToken: options.sidecar?.authToken,
		});
		for (const proxy of createSidecarProxies(proxyConfig)) {
			executorRegistry.register(proxy);
		}
	}

	const issuer = new CapabilityIssuer(policyEngine, taintTracker, tokenStore, options.signingKey);

	const hooks = options.hooks ?? {};
	const runState = new RunStateTracker(options.runStatePolicy);

	// Key persistent taint by principal.name (stable, caller-supplied) rather than
	// principal.id (random ULID per Firewall instance) so two runs for the same
	// logical principal share state.
	let persistentTaint: PersistentTaintRegistry | null = null;
	if (options.persistentTaint?.enabled) {
		persistentTaint = new PersistentTaintRegistry(
			auditStore,
			principal.name,
			options.persistentTaint,
		);
		persistentTaint.initializeRunState(runState);
	}

	auditStore.startRun(runId, principal.id, {
		principal: options.principal,
		policies: Array.isArray(options.policies) ? "[inline]" : options.policies,
	});

	const securityMode = options.securityMode ?? (options.signingKey ? "secure" : "dev");

	const pipeline = new Pipeline(
		runId,
		principal,
		policyEngine,
		taintTracker,
		auditStore,
		executorRegistry,
		options.hooks ?? {},
		tokenStore,
		runState,
		options.signingKey,
		securityMode,
		persistentTaint ?? undefined,
	);

	return {
		runId,
		principal,
		policyEngine,
		taintTracker,
		auditStore,
		executorRegistry,
		pipeline,
		issuer,
		tokenStore,
		hooks,
		runState,
		persistentTaint,
		mode,
		sidecarOptions,
		sidecarClient,
	};
}
