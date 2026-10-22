import type { AuditStore } from "@arikernel/audit-log";
import type {
	CapabilityClass,
	CapabilityConstraint,
	CapabilityRequest,
	IssuanceDecision,
	Principal,
	TaintLabel,
} from "@arikernel/core";
import { CAPABILITY_CLASS_MAP, generateId, now } from "@arikernel/core";
import { applyBehavioralRule, evaluateBehavioralRules, ruleDenialText } from "../behavioral-rules.js";
import type { FirewallHooks } from "../hooks.js";
import type { CapabilityIssuer } from "../issuer.js";
import type { RunStateTracker } from "../run-state.js";
import type { ITokenStore } from "../token-store.js";

export interface IssuanceContext {
	principal: Principal;
	issuer: CapabilityIssuer;
	runState: RunStateTracker;
	auditStore: AuditStore;
	tokenStore: ITokenStore;
	runId: string;
	hooks: FirewallHooks;
}

export interface RequestOptions {
	constraints?: CapabilityConstraint;
	taintLabels?: TaintLabel[];
	justification?: string;
}

export function requestCapabilityLocal(
	ctx: IssuanceContext,
	capabilityClass: CapabilityClass,
	options?: RequestOptions,
): IssuanceDecision {
	// Merge explicit taint labels with kernel-maintained run-level taint so
	// taint propagates to capability issuance even when the agent omits
	// taintLabels — the kernel tracks taint, not the agent.
	let taintLabels = options?.taintLabels ?? [];
	if (ctx.runState.tainted && !ctx.runState.hostAdjudicatesDataFlow) {
		const runLabels = ctx.runState.accumulatedTaintLabels as TaintLabel[];
		if (runLabels.length > 0) {
			const seen = new Set(taintLabels.map((l) => `${l.source}:${l.origin}`));
			for (const label of runLabels) {
				const key = `${label.source}:${label.origin}`;
				if (!seen.has(key)) {
					seen.add(key);
					taintLabels = [...taintLabels, label];
				}
			}
		}
	}

	const request: CapabilityRequest = {
		id: generateId(),
		principalId: ctx.principal.id,
		capabilityClass,
		constraints: options?.constraints,
		taintLabels,
		justification: options?.justification,
		timestamp: now(),
	};

	// Deny unknown capability classes — fail closed instead of crashing
	if (!(capabilityClass in CAPABILITY_CLASS_MAP)) {
		ctx.runState.recordCapabilityRequest(false);
		const denied: IssuanceDecision = {
			requestId: request.id,
			granted: false,
			reason:
				`Unknown capability class '${capabilityClass}'. ` +
				`Valid classes: ${Object.keys(CAPABILITY_CLASS_MAP).join(", ")}`,
			taintLabels: request.taintLabels,
			timestamp: now(),
		};
		ctx.hooks.onIssuance?.(request, denied);
		return denied;
	}

	// Block non-read-only capability issuance in restricted mode
	if (ctx.runState.restricted) {
		const mapping = CAPABILITY_CLASS_MAP[capabilityClass];
		const safeReadOnly = mapping.actions.every((a) =>
			ctx.runState.isAllowedInRestrictedMode(mapping.toolClass, a),
		);
		if (!safeReadOnly) {
			ctx.runState.recordCapabilityRequest(false);
			ctx.runState.pushEvent({
				timestamp: request.timestamp,
				type: "capability_denied",
				toolClass: mapping.toolClass,
				metadata: { capabilityClass, reason: "restricted_mode" },
			});
			const denied: IssuanceDecision = {
				requestId: request.id,
				granted: false,
				reason:
					`Run is in restricted mode (entered at ${ctx.runState.restrictedAt}). ` +
					`Only read-only capabilities can be issued. '${capabilityClass}' is blocked.`,
				taintLabels: request.taintLabels,
				timestamp: now(),
			};
			ctx.hooks.onIssuance?.(request, denied);
			return denied;
		}
	}

	const mapping = CAPABILITY_CLASS_MAP[capabilityClass];
	ctx.runState.pushEvent({
		timestamp: request.timestamp,
		type: "capability_requested",
		toolClass: mapping.toolClass,
		metadata: { capabilityClass },
	});

	const issued = ctx.issuer.evaluate(request, ctx.principal);
	ctx.runState.recordCapabilityRequest(issued.granted);

	ctx.runState.pushEvent({
		timestamp: issued.timestamp,
		type: issued.granted ? "capability_granted" : "capability_denied",
		toolClass: mapping.toolClass,
		metadata: { capabilityClass },
	});

	const decision = refusedByRule(ctx, request, issued) ?? issued;

	ctx.hooks.onIssuance?.(request, decision);

	return decision;
}

// A behavioral rule that matches on this request (a riskier capability after
// a denied one) refuses it: the grant just issued is revoked and the decision
// returned is a denial naming the rule. The run goes on; the refusal counts.
function refusedByRule(
	ctx: IssuanceContext,
	request: CapabilityRequest,
	issued: IssuanceDecision,
): IssuanceDecision | null {
	if (!ctx.runState.behavioralRulesEnabled) return null;
	const match = evaluateBehavioralRules(ctx.runState);
	if (!match) return null;
	const denial = applyBehavioralRule(ctx.runState, match);
	ctx.auditStore.appendSystemEvent(ctx.runId, ctx.principal.id, "rule_denied", denial.reason, {
		ruleId: denial.ruleId,
		deniedActions: denial.deniedActions,
		threshold: denial.threshold,
		restricted: denial.restricted,
		matchedEvents: denial.matchedEvents,
	});
	if (issued.grant) ctx.tokenStore.revoke(issued.grant.id);
	return {
		requestId: request.id,
		granted: false,
		reason: `Capability '${request.capabilityClass}' ${ruleDenialText(denial)}`,
		taintLabels: request.taintLabels,
		timestamp: now(),
	};
}
