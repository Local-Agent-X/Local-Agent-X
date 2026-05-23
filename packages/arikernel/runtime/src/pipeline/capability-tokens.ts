import type { CapabilityConstraint, Decision, ToolCall, ToolCallRequest } from "@arikernel/core";
import {
	CAPABILITY_CLASS_MAP,
	ToolCallDeniedError,
	now,
	verifyCapabilityToken,
} from "@arikernel/core";
import { validateCommand } from "../command-security.js";
import { isPathAllowed } from "../path-security.js";
import { type PipelineContext, denyAndThrow, logEvent } from "./context.js";
import { isProtected } from "./protected-actions.js";

// Step 1.5c: Capability enforcement. Protected tool calls REQUIRE a valid grant.
// If tokens are enforced and the request carries a grantId, validate it. If no
// grantId and the action is protected, deny outright.
export function enforceCapabilityToken(
	ctx: PipelineContext,
	toolCall: ToolCall,
	request: ToolCallRequest,
): void {
	const enforceTokens = ctx.securityMode === "secure" || !!ctx.tokenStore;
	if (!enforceTokens || !ctx.tokenStore) return;

	if (request.grantId) {
		validateToken(ctx, toolCall, request.grantId);
		return;
	}
	if (isProtected(toolCall.toolClass, toolCall.action)) {
		const decision: Decision = {
			verdict: "deny",
			matchedRule: null,
			reason: `Capability token required for protected action '${toolCall.toolClass}.${toolCall.action}'. Request a capability grant before executing this tool call.`,
			taintLabels: toolCall.taintLabels,
			timestamp: now(),
		};
		ctx.runState?.recordDeniedAction();
		logEvent(ctx, toolCall, decision);
		throw new ToolCallDeniedError(toolCall, decision);
	}
}

function validateToken(ctx: PipelineContext, toolCall: ToolCall, grantId: string): void {
	const grant = ctx.tokenStore?.get(grantId);

	if (!grant) {
		denyAndThrow(ctx, toolCall, `Capability token not found: ${grantId}`);
	}

	if (ctx.signingKey) {
		const stored = ctx.tokenStore?.getStoredToken(grantId);
		if (!stored?.signature || !stored?.algorithm) {
			denyAndThrow(
				ctx,
				toolCall,
				`Signing is enabled but token '${grantId}' has no signature`,
			);
		}
		const verification = verifyCapabilityToken(
			{ grant, signature: stored.signature, algorithm: stored.algorithm },
			ctx.signingKey,
		);
		if (!verification.valid) {
			denyAndThrow(ctx, toolCall, `Token signature verification failed: ${verification.reason}`);
		}
	}

	if (grant.principalId !== toolCall.principalId) {
		denyAndThrow(
			ctx,
			toolCall,
			`Capability token principal '${grant.principalId}' does not match caller '${toolCall.principalId}'`,
		);
	}

	const mapping = CAPABILITY_CLASS_MAP[grant.capabilityClass];

	if (mapping.toolClass !== toolCall.toolClass) {
		denyAndThrow(
			ctx,
			toolCall,
			`Token for '${grant.capabilityClass}' cannot be used for tool class '${toolCall.toolClass}'`,
		);
	}

	if (!mapping.actions.includes(toolCall.action)) {
		denyAndThrow(
			ctx,
			toolCall,
			`Token for '${grant.capabilityClass}' does not permit action '${toolCall.action}'`,
		);
	}

	const constraintViolation = checkGrantConstraints(toolCall, grant.constraints);
	if (constraintViolation) {
		denyAndThrow(ctx, toolCall, `Grant constraint violation: ${constraintViolation}`);
	}

	// Atomically validate + consume one use (prevents TOCTOU double-spend)
	const consumed = ctx.tokenStore?.consume(grantId);
	if (consumed && !consumed.valid) {
		denyAndThrow(ctx, toolCall, `Capability token invalid: ${consumed.reason}`);
	}
}

function checkGrantConstraints(
	toolCall: ToolCall,
	constraints: CapabilityConstraint,
): string | null {
	if (constraints.allowedHosts && toolCall.toolClass === "http") {
		const url = String(toolCall.parameters.url ?? "");
		try {
			const hostname = new URL(url).hostname;
			if (
				!constraints.allowedHosts.includes("*") &&
				!constraints.allowedHosts.includes(hostname)
			) {
				return `Host '${hostname}' not in allowed hosts: ${constraints.allowedHosts.join(", ")}`;
			}
		} catch {
			return `Invalid URL: ${url}`;
		}
	}

	if (constraints.allowedCommands && toolCall.toolClass === "shell") {
		const command = String(toolCall.parameters.command ?? "");
		const violation = validateCommand(command, constraints.allowedCommands);
		if (violation) {
			return violation;
		}
	}

	if (constraints.allowedPaths && toolCall.toolClass === "file") {
		const path = String(toolCall.parameters.path ?? "");
		const { allowed, canonicalPath } = isPathAllowed(path, constraints.allowedPaths);
		if (!allowed) {
			return `Path '${canonicalPath}' not in allowed paths: ${constraints.allowedPaths.join(", ")}`;
		}
	}

	if (constraints.allowedDatabases && toolCall.toolClass === "database") {
		const db = String(toolCall.parameters.database ?? "");
		// Require an exact match on the explicit `database` parameter only.
		// Matching a database name inside raw SQL is bypassable (comments,
		// string literals, identifiers), so only the structured parameter is
		// trustworthy.
		if (!constraints.allowedDatabases.includes(db)) {
			return `Database not in allowed list: ${constraints.allowedDatabases.join(", ")}`;
		}
	}

	return null;
}
