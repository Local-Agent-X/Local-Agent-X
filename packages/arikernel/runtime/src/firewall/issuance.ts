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
import { applyBehavioralRule, evaluateBehavioralRules } from "../behavioral-rules.js";
import type { FirewallHooks } from "../hooks.js";
import type { CapabilityIssuer } from "../issuer.js";
import type { RunStateTracker } from "../run-state.js";
import type { SidecarHttpClient } from "../sidecar-proxy.js";

export interface IssuanceContext {
	principal: Principal;
	issuer: CapabilityIssuer;
	runState: RunStateTracker;
	auditStore: AuditStore;
	runId: string;
	hooks: FirewallHooks;
	sidecarClient?: SidecarHttpClient;
}

export interface RequestOptions {
	constraints?: CapabilityConstraint;
	taintLabels?: TaintLabel[];
	justification?: string;
}

export function requestCapabilitySync(
	ctx: IssuanceContext,
	capabilityClass: CapabilityClass,
	options?: RequestOptions,
): IssuanceDecision {
	// In sidecar mode, synchronous requestCapability cannot route to the
	// sidecar (HTTP is async). Return a synthetic non-authoritative grant.
	//
	// SAFETY: This synthetic grant cannot bypass sidecar authority because:
	// 1. execute() routes directly to the sidecar, never consulting local tokens
	// 2. The grant has empty lease/nonce values that would fail real validation
	// 3. No local pipeline code path runs in sidecar mode
	//
	// Callers SHOULD use requestCapabilityAsync() for a real sidecar decision.
	if (ctx.sidecarClient) {
		const ts = now();
		const requestId = generateId();
		return {
			requestId,
			granted: true,
			grant: {
				id: generateId(),
				requestId,
				principalId: ctx.principal.id,
				capabilityClass,
				constraints: (options?.constraints ?? {}) as CapabilityConstraint,
				lease: {
					issuedAt: ts,
					expiresAt: "",
					maxCalls: 0,
					callsUsed: 0,
				},
				taintContext: options?.taintLabels ?? [],
				revoked: false,
				nonce: "",
			},
			reason: "Sidecar-mode: authoritative grant issued by sidecar on execute()",
			taintLabels: options?.taintLabels ?? [],
			timestamp: ts,
		};
	}

	return requestCapabilityLocal(ctx, capabilityClass, options);
}

export async function requestCapabilityAsync(
	ctx: IssuanceContext,
	capabilityClass: CapabilityClass,
	options?: RequestOptions,
): Promise<IssuanceDecision> {
	if (ctx.sidecarClient) {
		const decision = await ctx.sidecarClient.requestCapability(capabilityClass, {
			constraints: options?.constraints as Record<string, unknown> | undefined,
			taintLabels: options?.taintLabels,
			justification: options?.justification,
		});

		// Fire local hooks for observability (non-authoritative)
		ctx.hooks.onIssuance?.(
			{
				id: decision.requestId,
				principalId: ctx.principal.id,
				capabilityClass,
				constraints: options?.constraints,
				taintLabels: options?.taintLabels ?? [],
				justification: options?.justification,
				timestamp: decision.timestamp,
			},
			decision,
		);

		return decision;
	}

	return requestCapabilityLocal(ctx, capabilityClass, options);
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
	if (ctx.runState.tainted) {
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

	const decision = ctx.issuer.evaluate(request, ctx.principal);
	ctx.runState.recordCapabilityRequest(decision.granted);

	ctx.runState.pushEvent({
		timestamp: decision.timestamp,
		type: decision.granted ? "capability_granted" : "capability_denied",
		toolClass: mapping.toolClass,
		metadata: { capabilityClass },
	});

	checkBehavioralRulesFromCapability(ctx);

	ctx.hooks.onIssuance?.(request, decision);

	return decision;
}

export function checkBehavioralRulesFromCapability(ctx: IssuanceContext): void {
	if (!ctx.runState.behavioralRulesEnabled) return;
	const match = evaluateBehavioralRules(ctx.runState);
	if (!match) return;
	const quarantine = applyBehavioralRule(ctx.runState, match);
	if (quarantine) {
		ctx.auditStore.appendSystemEvent(ctx.runId, ctx.principal.id, "quarantine", quarantine.reason, {
			triggerType: quarantine.triggerType,
			ruleId: quarantine.ruleId,
			counters: quarantine.countersSnapshot,
			matchedEvents: quarantine.matchedEvents,
		});
	}
}
