/**
 * The enforcement switch is closed: a verdict it does not know is a deny.
 * Loaded policies are schema-checked, so an unknown verdict can only come from
 * a rule that bypassed the loader; the tool must still not run.
 */

import { ToolCallDeniedError } from "@arikernel/core";
import { describe, expect, it } from "vitest";
import { createFirewall } from "../src/index.js";

describe("unknown policy verdict", () => {
	it("denies the call and never runs the tool", async () => {
		const fw = createFirewall({
			principal: {
				name: "test-agent",
				capabilities: [{ toolClass: "http", actions: ["get"], constraints: { allowedHosts: ["*"] } }],
			},
			policies: [
				{
					id: "allow-get",
					name: "Allow get",
					priority: 1,
					match: { toolClass: "http", action: "get" },
					decision: "allow",
					reason: "reads are fine",
				},
			],
			auditLog: ":memory:",
		});
		let ran = false;
		fw.registerExecutor({
			toolClass: "http",
			async execute(toolCall) {
				ran = true;
				return { callId: toolCall.id, success: true, data: null, durationMs: 1, taintLabels: [] };
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: reaching past the loader is the point of this test
		const rules = (fw as any).policyEngine.rules as Array<{ id: string; decision: string }>;
		const rule = rules.find((r) => r.id === "allow-get");
		if (!rule) throw new Error("rule not loaded");
		rule.decision = "dney";

		const grant = fw.requestCapability("http.read");
		try {
			await expect(
				fw.execute({ toolClass: "http", action: "get", parameters: { url: "http://example.com" }, grantId: grant.grant?.id }),
			).rejects.toThrow(ToolCallDeniedError);
			expect(ran).toBe(false);
		} finally {
			fw.close();
		}
	});
});
