import type { AuditStore } from "@arikernel/audit-log";
import type { Principal, TaintLabel, ToolClass } from "@arikernel/core";
import { generateId, now } from "@arikernel/core";
import { applyBehavioralRule, evaluateBehavioralRules } from "../behavioral-rules.js";
import type { FirewallHooks } from "../hooks.js";
import type { QuarantineInfo, RunStateTracker } from "../run-state.js";

export interface AuditContext {
	principal: Principal;
	runId: string;
	runState: RunStateTracker;
	auditStore: AuditStore;
	hooks: FirewallHooks;
}

export interface AuditOptions {
	toolClass: ToolClass;
	action: string;
	parameters: Record<string, unknown>;
	taintLabels?: TaintLabel[];
	parentCallId?: string;
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
export function audit(ctx: AuditContext, opts: AuditOptions): QuarantineInfo | null {
	const timestamp = now();
	const toolCall = {
		id: generateId(),
		runId: ctx.runId,
		sequence: 0, // overwritten by AuditStore.append
		timestamp,
		principalId: ctx.principal.id,
		toolClass: opts.toolClass,
		action: opts.action,
		parameters: opts.parameters,
		taintLabels: opts.taintLabels ?? [],
		parentCallId: opts.parentCallId,
	};
	const decision = {
		verdict: "allow" as const,
		matchedRule: null,
		reason: "audit-only (internal class — no I/O sink to gate)",
		taintLabels: opts.taintLabels ?? [],
		timestamp,
	};

	// Hash-chained append. Wrapped because a DB failure here must not
	// cascade into a thrown tool call — audit best-effort, execution
	// authoritative.
	try {
		const event = ctx.auditStore.append(toolCall, decision);
		ctx.hooks.onAudit?.(event);
		ctx.hooks.onDecision?.(toolCall, decision);
	} catch {
		// Swallow — see method doc.
	}

	// Feed behavioral rules. Audit-only calls count toward rate/anomaly
	// thresholds even though they aren't I/O — that's the whole point of
	// the change: kernel sees the full call shape, not just the I/O half.
	ctx.runState.pushEvent({
		timestamp,
		type: "tool_call_allowed",
		toolClass: opts.toolClass,
		action: opts.action,
		verdict: "allow",
		metadata: { auditOnly: true },
	});
	if (ctx.runState.behavioralRulesEnabled) {
		const match = evaluateBehavioralRules(ctx.runState);
		if (match) {
			const qi = applyBehavioralRule(ctx.runState, match);
			if (qi) return qi;
		}
	}
	return null;
}
