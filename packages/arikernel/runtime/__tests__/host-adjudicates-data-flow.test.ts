import { describe, expect, it } from "vitest";
import { evaluateBehavioralRules } from "../src/behavioral-rules.js";
import { collectInputTaints, propagateOutputTaint } from "../src/pipeline/taint-flow.js";
import type { PipelineContext } from "../src/pipeline/context.js";
import type { SecurityEvent } from "../src/run-state.js";
import { RunStateTracker } from "../src/run-state.js";
import { TaintTracker } from "@arikernel/taint-tracker";
import type { TaintLabel, ToolCall, ToolResult } from "@arikernel/core";

// A host that decides data flow on the bytes at every sink (LAX: fingerprint
// overlap + registered-secret scan) sets RunStatePolicy.hostAdjudicatesDataFlow.
// The same run history that trips the data-flow rules by default must then trip
// nothing, the run's accumulated labels must not reach later calls, and the
// one rule that is not about data flow must still fire.

function ev(type: SecurityEvent["type"], overrides?: Partial<SecurityEvent>): SecurityEvent {
	return { timestamp: new Date().toISOString(), type, ...overrides };
}

function history(state: RunStateTracker, kind: "web_then_egress" | "read_then_egress" | "taint_then_db_write" | "taint_then_long_shell"): void {
	if (kind === "read_then_egress") {
		state.pushEvent(ev("sensitive_read_attempt", { toolClass: "file", action: "read" }));
		state.confirmSensitiveFileRead();
		state.pushEvent(ev("egress_attempt", { toolClass: "http", action: "post" }));
		return;
	}
	state.pushEvent(ev("taint_observed", { taintSources: ["web"] }));
	state.markTainted("web");
	if (kind === "web_then_egress") state.pushEvent(ev("egress_attempt", { toolClass: "http", action: "post" }));
	if (kind === "taint_then_db_write") state.pushEvent(ev("tool_call_allowed", { toolClass: "database", action: "mutate" }));
	if (kind === "taint_then_long_shell") state.pushEvent(ev("tool_call_allowed", { toolClass: "shell", action: "exec", metadata: { commandLength: 400 } }));
}

describe("RunStatePolicy.hostAdjudicatesDataFlow", () => {
	it.each(["web_then_egress", "read_then_egress"] as const)("%s: fires by default, not when the host adjudicates", (kind) => {
		const byDefault = new RunStateTracker({ behavioralRules: true });
		history(byDefault, kind);
		expect(evaluateBehavioralRules(byDefault)).not.toBeNull();

		const hosted = new RunStateTracker({ behavioralRules: true, hostAdjudicatesDataFlow: true });
		history(hosted, kind);
		expect(evaluateBehavioralRules(hosted)).toBeNull();
	});

	it.each(["taint_then_db_write", "taint_then_long_shell"] as const)("%s: no data-flow rule fires when the host adjudicates", (kind) => {
		const hosted = new RunStateTracker({ behavioralRules: true, hostAdjudicatesDataFlow: true });
		history(hosted, kind);
		expect(evaluateBehavioralRules(hosted)).toBeNull();
	});

	it("capability escalation after a denial is not about data flow and still fires", () => {
		const hosted = new RunStateTracker({ behavioralRules: true, hostAdjudicatesDataFlow: true });
		hosted.pushEvent(ev("capability_denied", { toolClass: "http" }));
		hosted.pushEvent(ev("capability_requested", { toolClass: "shell" }));
		expect(evaluateBehavioralRules(hosted)?.ruleId).toBe("denied_capability_then_escalation");
	});

	it("the run's accumulated labels are not merged into a later call, by default they are", () => {
		const web: TaintLabel = { source: "web", origin: "https://page.example", confidence: 1, addedAt: new Date().toISOString() };
		const call = { id: "c2", runId: "r", sequence: 2, timestamp: new Date().toISOString(), principalId: "p", toolClass: "http", action: "post", parameters: { url: "https://api.example/x" }, taintLabels: [] } as unknown as ToolCall;
		for (const host of [false, true]) {
			const runState = new RunStateTracker({ behavioralRules: true, hostAdjudicatesDataFlow: host });
			runState.accumulateTaintLabels([web]);
			const ctx = { runState, taintTracker: new TaintTracker() } as unknown as PipelineContext;
			const input = collectInputTaints(ctx, call);
			const result = { callId: "c2", success: true, data: "ok", durationMs: 1, taintLabels: [] } as unknown as ToolResult;
			propagateOutputTaint(ctx, call, result, input);
			if (host) {
				expect(input).toEqual([]);
				expect(result.taintLabels.map((l) => l.source)).not.toContain("web");
			} else {
				expect(input.map((l) => l.source)).toContain("web");
				expect(result.taintLabels.map((l) => l.source)).toContain("web");
			}
			// Audit still sees what the run carried.
			expect(runState.tainted).toBe(true);
		}
	});
});
