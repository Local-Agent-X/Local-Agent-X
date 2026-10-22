import { AuditStore } from "@arikernel/audit-log";
import type { Principal } from "@arikernel/core";
import { generateId } from "@arikernel/core";
import { PolicyEngine } from "@arikernel/policy-engine";
import { TaintTracker } from "@arikernel/taint-tracker";
import { ExecutorRegistry } from "@arikernel/tool-executors";
import type { FirewallOptions } from "../config.js";
import { validateOptions } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import { CapabilityIssuer } from "../issuer.js";
import { Pipeline } from "../pipeline.js";
import { RunStateTracker } from "../run-state.js";
import { type ITokenStore, TokenStore } from "../token-store.js";

export interface ConstructedFirewall {
	runId: string;
	principal: Principal;
	policyEngine: PolicyEngine;
	taintTracker: TaintTracker;
	auditStore: AuditStore;
	ownsAuditStore: boolean;
	executorRegistry: ExecutorRegistry;
	pipeline: Pipeline;
	issuer: CapabilityIssuer;
	tokenStore: ITokenStore;
	hooks: FirewallHooks;
	runState: RunStateTracker;
}

export function constructFirewall(options: FirewallOptions): ConstructedFirewall {
	validateOptions(options);

	const runId = generateId();

	const principal: Principal = {
		id: generateId(),
		name: options.principal.name,
		capabilities: options.principal.capabilities,
	};

	const policyEngine = new PolicyEngine(options.policies);
	const taintTracker = new TaintTracker();
	const auditStore = options.auditStore ?? new AuditStore(options.auditLog ?? "./audit.db", options.auditHmacKey);
	const ownsAuditStore = options.auditStore === undefined;
	const executorRegistry = new ExecutorRegistry();
	const tokenStore: ITokenStore = options.tokenStore ?? new TokenStore();

	const issuer = new CapabilityIssuer(policyEngine, taintTracker, tokenStore, options.signingKey);

	const hooks = options.hooks ?? {};
	const runState = new RunStateTracker(options.runStatePolicy);

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
	);

	return {
		runId,
		principal,
		policyEngine,
		taintTracker,
		auditStore,
		ownsAuditStore,
		executorRegistry,
		pipeline,
		issuer,
		tokenStore,
		hooks,
		runState,
	};
}
