import type { AuditStore } from "@arikernel/audit-log";
import type {
	Capability,
	DelegatedCapability,
	DelegationResult,
	Principal,
} from "@arikernel/core";
import { createDelegatedPrincipal, generateId, now, revokeDelegationsFrom } from "@arikernel/core";
import type { PolicyEngine } from "@arikernel/policy-engine";
import type { EnforcementMode, FirewallOptions } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import type { QuarantineInfo, RunStateTracker } from "../run-state.js";

export interface DelegationContext {
	principal: Principal;
	policyEngine: PolicyEngine;
	hooks: FirewallHooks;
	runState: RunStateTracker;
	mode: EnforcementMode;
	sidecarOptions?: import("../config.js").SidecarConnectionOptions;
	auditStore: AuditStore;
	runId: string;
}

export interface DelegateResult<F> {
	firewall: F;
	denied: DelegationResult[];
}

/**
 * Delegate a subset of the parent's capabilities to a child principal.
 * The child receives the intersection of the parent's capabilities and the
 * requested set — delegation can only narrow, never widen.
 */
export function delegateToChild<F>(
	ctx: DelegationContext,
	childName: string,
	requestedCapabilities: Capability[],
	makeFirewall: (options: FirewallOptions) => F,
	overridePrincipal: (firewall: F, principal: Principal) => void,
): DelegateResult<F> {
	const childId = generateId();
	const { principal: childPrincipal, denied } = createDelegatedPrincipal(
		{ ...ctx.principal, capabilities: ctx.principal.capabilities as DelegatedCapability[] },
		childId,
		childName,
		requestedCapabilities,
		now(),
	);

	const childFirewall = makeFirewall({
		principal: {
			name: childPrincipal.name,
			capabilities: childPrincipal.capabilities,
		},
		policies: [...ctx.policyEngine.getRules()],
		hooks: ctx.hooks,
		runStatePolicy: ctx.runState.policy,
		mode: ctx.mode,
		sidecar: ctx.sidecarOptions,
	});

	// Override the generated principal to preserve parentId and delegation metadata
	overridePrincipal(childFirewall, childPrincipal);

	return { firewall: childFirewall, denied };
}

export function revokeDelegationsFromPrincipal(
	principal: Principal,
	principalId: string,
): Capability[] {
	return revokeDelegationsFrom(principal.capabilities as DelegatedCapability[], principalId);
}

export function quarantineExternal(
	ctx: Pick<DelegationContext, "runState" | "auditStore" | "runId" | "principal">,
	ruleId: string,
	reason: string,
): QuarantineInfo | null {
	const result = ctx.runState.quarantineByRule(ruleId, reason, []);
	if (result) {
		ctx.auditStore.appendSystemEvent(ctx.runId, ctx.principal.id, "quarantine", reason, {
			triggerType: "cross_principal_alert",
			ruleId,
			counters: result.countersSnapshot,
		});
	}
	return result;
}
