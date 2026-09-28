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
import { applyBehavioralRule, evaluateBehavioralRules, ruleDenialText } from "../behavioral-rules.js";
import type { SecurityMode } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import type { PersistentTaintRegistry } from "../persistent-taint-registry.js";
import type { RuleDenial, RunStateTracker } from "../run-state.js";
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

// Evaluate the behavioral rules against the call whose event was just pushed.
// A match refuses that call: the refusal is counted and recorded, and the
// caller throws it with denyByRule. Null when no rule matched.
export function checkBehavioralRules(ctx: PipelineContext, toolCall: ToolCall): RuleDenial | null {
	if (!ctx.runState?.behavioralRulesEnabled) return null;
	const match = evaluateBehavioralRules(ctx.runState);
	if (!match) return null;
	const denial = applyBehavioralRule(ctx.runState, match);
	ctx.auditStore.appendSystemEvent(toolCall.runId, toolCall.principalId, "rule_denied", denial.reason, {
		ruleId: denial.ruleId,
		deniedActions: denial.deniedActions,
		threshold: denial.threshold,
		restricted: denial.restricted,
		matchedEvents: denial.matchedEvents,
	});
	return denial;
}

// Throw the refusal a behavioral rule produced for this call. The denial was
// counted when it was produced (RunStateTracker.denyByRule), so this only
// records and throws it.
export function denyByRule(ctx: PipelineContext, toolCall: ToolCall, denial: RuleDenial): never {
	const decision: Decision = {
		verdict: "deny",
		matchedRule: null,
		reason: `Action '${toolCall.toolClass}.${toolCall.action}' ${ruleDenialText(denial)}`,
		taintLabels: toolCall.taintLabels,
		timestamp: now(),
	};
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
