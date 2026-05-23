import type { AuditStore } from "@arikernel/audit-log";
import type {
	AuditEvent,
	Decision,
	Principal,
	SigningKey,
	ToolCall,
	ToolResult,
} from "@arikernel/core";
import { ToolCallDeniedError, now } from "@arikernel/core";
import type { PolicyEngine } from "@arikernel/policy-engine";
import type { TaintTracker } from "@arikernel/taint-tracker";
import type { ExecutorRegistry } from "@arikernel/tool-executors";
import { applyBehavioralRule, evaluateBehavioralRules } from "../behavioral-rules.js";
import type { SecurityMode } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import type { PersistentTaintRegistry } from "../persistent-taint-registry.js";
import type { RunStateTracker } from "../run-state.js";
import type { ITokenStore } from "../token-store.js";

export interface PipelineContext {
	runId: string;
	principal: Principal;
	policyEngine: PolicyEngine;
	taintTracker: TaintTracker;
	auditStore: AuditStore;
	executorRegistry: ExecutorRegistry;
	hooks: FirewallHooks;
	tokenStore?: ITokenStore;
	runState?: RunStateTracker;
	signingKey?: SigningKey;
	securityMode: SecurityMode;
	persistentTaint?: PersistentTaintRegistry;
}

export function logEvent(
	ctx: PipelineContext,
	toolCall: ToolCall,
	decision: Decision,
	result?: ToolResult,
): AuditEvent {
	const event = ctx.auditStore.append(toolCall, decision, result);
	ctx.hooks.onAudit?.(event);
	return event;
}

// Evaluate behavioral rules and apply quarantine if matched.
// Returns true if quarantine was newly triggered — callers should deny the
// current action to prevent first-hit exfiltration.
export function checkBehavioralRules(ctx: PipelineContext, toolCall: ToolCall): boolean {
	if (!ctx.runState?.behavioralRulesEnabled) return false;
	const match = evaluateBehavioralRules(ctx.runState);
	if (!match) return false;
	const quarantine = applyBehavioralRule(ctx.runState, match);
	if (quarantine) {
		ctx.auditStore.appendSystemEvent(
			toolCall.runId,
			toolCall.principalId,
			"quarantine",
			quarantine.reason,
			{
				triggerType: quarantine.triggerType,
				ruleId: quarantine.ruleId,
				counters: quarantine.countersSnapshot,
				matchedEvents: quarantine.matchedEvents,
			},
		);
		return true;
	}
	return false;
}

// Deny the current action because a behavioral rule just triggered quarantine.
// This prevents first-hit exfiltration where the triggering action itself would
// otherwise proceed despite causing quarantine.
export function denyQuarantinedAction(
	ctx: PipelineContext,
	toolCall: ToolCall,
	context: string,
): never {
	const decision: Decision = {
		verdict: "deny",
		matchedRule: null,
		reason: `Action '${toolCall.toolClass}.${toolCall.action}' denied: ${context}. Run has been quarantined.`,
		taintLabels: toolCall.taintLabels,
		timestamp: now(),
	};
	ctx.runState?.recordDeniedAction();
	logEvent(ctx, toolCall, decision);
	throw new ToolCallDeniedError(toolCall, decision);
}

export function denyAndThrow(
	ctx: PipelineContext,
	toolCall: ToolCall,
	reason: string,
): never {
	const decision: Decision = {
		verdict: "deny",
		matchedRule: null,
		reason,
		taintLabels: toolCall.taintLabels,
		timestamp: now(),
	};
	ctx.runState?.recordDeniedAction();
	logEvent(ctx, toolCall, decision);
	throw new ToolCallDeniedError(toolCall, decision);
}
