import type { AuditStore } from "@arikernel/audit-log";
import type { Principal, TaintLabel } from "@arikernel/core";
import { generateId, now } from "@arikernel/core";
import type { TaintTracker } from "@arikernel/taint-tracker";
import { applyBehavioralRule, evaluateBehavioralRules } from "../behavioral-rules.js";
import type { RunStateTracker } from "../run-state.js";

export interface ObservationContext {
	principal: Principal;
	runId: string;
	taintTracker: TaintTracker;
	runState: RunStateTracker;
	auditStore: AuditStore;
}

export interface Observation {
	toolClass: string;
	action: string;
	data: unknown;
	callId?: string;
}

export function observeToolOutput(ctx: ObservationContext, observation: Observation): TaintLabel[] {
	const callId = observation.callId ?? generateId();

	const contentTaints = ctx.taintTracker.scanOutput(observation.data, callId);
	const autoTaints = deriveAutoTaint(observation.toolClass, observation.data);

	const allTaints = ctx.taintTracker.merge(contentTaints, autoTaints);
	if (allTaints.length === 0) return [];

	if (ctx.runState) {
		const priorSources = new Set(
			(ctx.runState.accumulatedTaintLabels as TaintLabel[]).map((t) => t.source),
		);

		ctx.runState.accumulateTaintLabels(allTaints);

		const newSources = [...new Set(allTaints.map((t) => t.source))].filter(
			(s) => !priorSources.has(s),
		);

		if (newSources.length > 0) {
			ctx.runState.pushEvent({
				timestamp: now(),
				type: "taint_observed",
				toolClass: observation.toolClass,
				action: observation.action,
				taintSources: newSources,
			});

			if (ctx.runState.behavioralRulesEnabled) {
				const match = evaluateBehavioralRules(ctx.runState);
				if (match) {
					const quarantine = applyBehavioralRule(ctx.runState, match);
					if (quarantine) {
						ctx.auditStore.appendSystemEvent(
							ctx.runId,
							ctx.principal.id,
							"quarantine",
							quarantine.reason,
							{
								triggerType: quarantine.triggerType,
								ruleId: quarantine.ruleId,
								counters: quarantine.countersSnapshot,
								matchedEvents: quarantine.matchedEvents,
							},
						);
					}
				}
			}
		}
	}

	return allTaints;
}

function deriveAutoTaint(toolClass: string, data: unknown): TaintLabel[] {
	const ts = now();
	if (toolClass === "http") {
		let origin = "unknown";
		if (typeof data === "object" && data !== null && "url" in data) {
			try {
				origin = new URL(String((data as Record<string, unknown>).url)).hostname;
			} catch {
				/* keep unknown */
			}
		}
		return [{ source: "web", origin, confidence: 1.0, addedAt: ts }];
	}
	if (toolClass === "retrieval") {
		return [{ source: "rag", origin: "retrieval", confidence: 0.9, addedAt: ts }];
	}
	return [];
}

export function injectExternalTaint(ctx: ObservationContext, labels: TaintLabel[]): void {
	if (labels.length === 0) return;
	ctx.runState.accumulateTaintLabels(labels);
	for (const label of labels) {
		ctx.runState.pushEvent({
			timestamp: now(),
			type: "taint_observed",
			toolClass: "external",
			action: "inject",
			taintSources: [label.source],
		});
	}
}
