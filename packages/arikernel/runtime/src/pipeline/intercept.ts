import type { AuditStore } from "@arikernel/audit-log";
import type {
	Decision,
	Principal,
	SigningKey,
	TaintLabel,
	ToolCall,
	ToolCallRequest,
	ToolResult,
} from "@arikernel/core";
import {
	ApprovalRequiredError,
	ToolCallDeniedError,
	generateId,
	now,
	toolCallRequestSchema,
} from "@arikernel/core";
import type { PolicyEngine } from "@arikernel/policy-engine";
import type { TaintTracker } from "@arikernel/taint-tracker";
import type { ExecutorRegistry } from "@arikernel/tool-executors";
import type { SecurityMode } from "../config.js";
import type { FirewallHooks } from "../hooks.js";
import type { PersistentTaintRegistry } from "../persistent-taint-registry.js";
import type { RunStateTracker } from "../run-state.js";
import type { ITokenStore } from "../token-store.js";
import { enforceCapabilityToken } from "./capability-tokens.js";
import { type PipelineContext, checkBehavioralRules, logEvent } from "./context.js";
import { enforceRestrictedMode } from "./restricted-gate.js";
import { emitPostPolicySignals, trackPreExecutionSignals } from "./run-state-signals.js";
import {
	accumulateOutputTaint,
	collectInputTaints,
	propagateOutputTaint,
	recordExecutionOutcome,
} from "./taint-flow.js";

export class Pipeline {
	private readonly ctx: PipelineContext;

	constructor(
		runId: string,
		principal: Principal,
		policyEngine: PolicyEngine,
		taintTracker: TaintTracker,
		auditStore: AuditStore,
		executorRegistry: ExecutorRegistry,
		hooks: FirewallHooks,
		tokenStore?: ITokenStore,
		runState?: RunStateTracker,
		signingKey?: SigningKey,
		securityMode: SecurityMode = "dev",
		persistentTaint?: PersistentTaintRegistry,
	) {
		this.ctx = {
			runId,
			principal,
			policyEngine,
			taintTracker,
			auditStore,
			executorRegistry,
			hooks,
			tokenStore,
			runState,
			signingKey,
			securityMode,
			persistentTaint,
		};
	}

	async intercept(request: ToolCallRequest): Promise<ToolResult> {
		// Step 1: Validate
		toolCallRequestSchema.parse(request);

		// Step 1.1: Apply model-generated taint.
		// All tool call requests originate from LLM output. This label ensures
		// behavioral rules track model-originated content through downstream tools.
		const toolCall = buildToolCall(this.ctx, request);

		// Step 1.5a: Run-state restriction
		enforceRestrictedMode(this.ctx, toolCall);

		// Step 1.5b: Track run-state signals and push security events
		trackPreExecutionSignals(this.ctx, toolCall);

		// Step 1.5c: Capability enforcement
		enforceCapabilityToken(this.ctx, toolCall, request);

		// Step 2: Collect taint
		const inputTaints = collectInputTaints(this.ctx, toolCall);

		// Step 3: Evaluate policy
		const decision = this.ctx.policyEngine.evaluate(
			toolCall,
			inputTaints,
			this.ctx.principal.capabilities,
		);

		this.ctx.hooks.onDecision?.(toolCall, decision);

		// Step 4: Enforce decision
		if (decision.verdict === "deny") {
			this.handleDeny(toolCall, decision);
		}

		if (decision.verdict === "require-approval") {
			await this.handleApproval(toolCall, decision);
		}

		// Step 4.5: Emit metadata for behavioral rules AFTER policy allowed
		emitPostPolicySignals(this.ctx, toolCall);

		// Step 5: Execute
		const result = await this.executeToolCall(toolCall, inputTaints);

		// Steps 5.5 + 6 + 6.1: Output taint scan + merge + run-level re-merge
		propagateOutputTaint(this.ctx, toolCall, result, inputTaints);

		// Step 6.2: Accumulate result taint labels into run-level state
		accumulateOutputTaint(this.ctx, toolCall, result);

		this.ctx.hooks.onExecute?.(toolCall, result);

		// Step 6.3: Output filtering (DLP hook)
		let filtered = result;
		if (this.ctx.hooks.onOutputFilter) {
			filtered = await this.ctx.hooks.onOutputFilter(toolCall, result);
		}

		// Step 6.5: Behavioral tracking + sensitive-read confirmation
		recordExecutionOutcome(this.ctx, toolCall, filtered);

		// Step 7: Audit log
		logEvent(this.ctx, toolCall, decision, filtered);

		return filtered;
	}

	private handleDeny(toolCall: ToolCall, decision: Decision): never {
		this.ctx.runState?.recordDeniedAction();
		if (this.ctx.runState) {
			this.ctx.runState.pushEvent({
				timestamp: toolCall.timestamp,
				type: "tool_call_denied",
				toolClass: toolCall.toolClass,
				action: toolCall.action,
				verdict: "deny",
			});
			// Behavioral rules may trigger quarantine here, but the action is
			// already being denied by policy — no extra denial needed.
			checkBehavioralRules(this.ctx, toolCall);
		}
		logEvent(this.ctx, toolCall, decision);
		throw new ToolCallDeniedError(toolCall, decision);
	}

	private async handleApproval(toolCall: ToolCall, decision: Decision): Promise<void> {
		if (!this.ctx.hooks.onApprovalRequired) {
			console.warn(
				`[arikernel] Policy returned 'require-approval' for ${toolCall.toolClass}.${toolCall.action} but no onApprovalRequired handler is registered. Action will be denied by default. Register a handler via hooks.onApprovalRequired to enable interactive approval.`,
			);
		}
		const approved = await this.ctx.hooks.onApprovalRequired?.(toolCall, decision);
		if (!approved) {
			const deniedDecision: Decision = {
				...decision,
				verdict: "deny",
				reason: `${decision.reason} (approval denied by user)`,
			};
			this.ctx.runState?.recordDeniedAction();
			logEvent(this.ctx, toolCall, deniedDecision);
			throw new ApprovalRequiredError(toolCall, deniedDecision);
		}
	}

	private async executeToolCall(
		toolCall: ToolCall,
		inputTaints: TaintLabel[],
	): Promise<ToolResult> {
		const executor = this.ctx.executorRegistry.get(toolCall.toolClass);
		if (!executor) {
			const noExecDecision: Decision = {
				verdict: "deny",
				matchedRule: null,
				reason: `No executor registered for tool class: ${toolCall.toolClass}`,
				taintLabels: inputTaints,
				timestamp: now(),
			};
			this.ctx.runState?.recordDeniedAction();
			logEvent(this.ctx, toolCall, noExecDecision);
			throw new ToolCallDeniedError(toolCall, noExecDecision);
		}

		try {
			return await executor.execute(toolCall);
		} catch (execError) {
			// Fail closed: executor crashes must never silently allow a call.
			// Audit-log the failure and update run-state so behavioral rules stay accurate.
			const execFailDecision: Decision = {
				verdict: "deny",
				matchedRule: null,
				reason: `Executor error (${toolCall.toolClass}): ${execError instanceof Error ? execError.message : String(execError)}`,
				taintLabels: inputTaints,
				timestamp: now(),
			};
			this.ctx.runState?.recordDeniedAction();
			logEvent(this.ctx, toolCall, execFailDecision);
			throw new ToolCallDeniedError(toolCall, execFailDecision);
		}
	}
}

function buildToolCall(ctx: PipelineContext, request: ToolCallRequest): ToolCall {
	const inputLabels = request.taintLabels ?? [];
	const safeToolClass = request.toolClass.slice(0, 64);
	// Canonicalize the action to lowercase at the primary ingest chokepoint so the
	// run-state behavioral layer (egress/exfil/path-drip/header inspection) sees the
	// same casing the matcher/executor already normalize to. Without this, an
	// uppercase action (e.g. "POST") executes but slips past every lowercase-literal
	// gate, emitting no egress_attempt. The ToolCall.action field carries no separate
	// raw/display variant, so canonicalizing it here is the single source of truth.
	const safeAction = request.action.slice(0, 64).toLowerCase();
	const hasModelTaint = inputLabels.some((l) => l.source === "model-generated");
	const taintLabels: TaintLabel[] = hasModelTaint
		? inputLabels
		: [
				...inputLabels,
				{
					source: "model-generated" as const,
					origin: `${safeToolClass}.${safeAction}`,
					confidence: 1.0,
					addedAt: now(),
				},
			];

	return {
		id: generateId(),
		runId: ctx.runId,
		sequence: 0,
		timestamp: now(),
		principalId: ctx.principal.id,
		toolClass: safeToolClass,
		action: safeAction,
		parameters: request.parameters,
		taintLabels,
		parentCallId: request.parentCallId,
		grantId: request.grantId,
	};
}
